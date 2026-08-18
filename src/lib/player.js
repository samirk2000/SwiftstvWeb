// Player utility: attaches HLS.js for .m3u8, native <video> otherwise, handles
// catchup start position, manifest retry/recovery on DVR stalls, PiP and the
// Screen Wake Lock — returning a small imperative controller.
//
// TV-browser caveats (also noted in README):
//  - AC3/EAC3 audio and some subtitles are not supported by every TV browser;
//    hls.js falls back/degrades but the panel's HE-AAC/AC3 streams may only
//    yield audio on capable devices. Best-effort only.
//  - DVR/archive playback needs the <video> `LiveSyncDurationCount` and a quick
//    seek when `video.paused`/stall handling returns far from the live edge.
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { needsOriginHeaders, originHeaderLines, defaultOriginHeaders } from './exclusivos.js';
import { streamProxyCandidates } from './proxy.js';

const RECOVERY_ATTEMPTS = 3;

export function buildSrcUrl(url, opts = {}) {
  return url;
}

// Xtream live/VOD/series panels hand back `http://` stream URLs and redirect
// even their `https://` manifests to an `http://IP:port` CDN. From our HTTPS
// page a browser blocks those as mixed active content, and the panels+CDN 403
// Cloudflare's ranges. So media is routed through an OUTSIDE stream proxy
// (Deno Deploy / Vercel) that resolves the redirects and serves https.
// Exclusivos (needs dynamic Referer/Origin + its own proxy) is left untouched.
export function mediaCandidates(url, { skipProxy = false, isExclusive = false, continuous = false } = {}) {
  if (skipProxy || isExclusive) return [url];
  const lu = String(url || '').toLowerCase();
  if (!lu) return [url];
  // Xtream media that MUST go through the outside stream proxy:
  //  - `http:` URLs (mixed-content from our HTTPS page).
  //  - any video extension (.m3u8/.mp4/.mkv/.ts) or Xtream route
  //    (/live/, /movie/, /series/) — the CDN does not answer a direct browser
  //    `video` request (0 bytes), so route even https video through the proxy.
  const isHls = /\.m3u8(\?|$)/i.test(lu);
  const isHttp = lu.startsWith('http:');
  const isVideoExt = /\.(mp4|m4v|mkv|ts|tsa|m3u8)(\?|$)/i.test(lu);
  const isXtreamRoute = /\/\/(?:[^/]+\/)?(live|movie|series)\//.test(lu);
  if (!isHls && !isHttp && !isVideoExt && !isXtreamRoute) return [url];
  return streamProxyCandidates(url, continuous ? { continuous: true } : {});
}

// Legacy single-URL helper: returns the preferred (first) candidate.
export function proxyMediaUrl(url, opts = {}) {
  return mediaCandidates(url, opts)[0];
}

// Determine the HLS.js config (extraOrigin applies dynamic Referer/Origin).
function hlsConfigFor(url, opts) {
  const cfg = {
    // Evita workers que disparen fetches en hilos paralelos no controlados.
    enableWorker: false,
    backBufferLength: 30,
    // Live: se sincroniza 3 segmentos detrás del en vivo y se permite hasta 5.
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 5,
    lowLatencyMode: false,
    // Búfer de datos: máx. 10s pedidos por adelantado (pico 15s), 30MB en RAM.
    // Reduce la carga paralela agresiva que abriría varias conexiones al panel.
    maxBufferLength: 10,
    maxMaxBufferLength: 15,
    maxBufferSize: 30 * 1024 * 1024,
    // No cortar la carga de un fragmento prematuramente (segmentos de varios MB).
    fragLoadingTimeOut: 30000,
    fragLoadingMaxRetry: 6,
    // Manifests .m3u8 vía proxy lento: timeout 10s y 3 reintentos para no
    // saturar con peticiones de playlist consecutivas.
    manifestLoadingTimeOut: 10000,
    manifestLoadingMaxRetry: 3,
    levelLoadingTimeOut: 15000,
    levelLoadingMaxRetry: 4,
    // Cache-busting of the manifest so DVR buffers don't go stale after stalls.
    progressive: true,
  };
  if (opts?.extraOrigin) {
    const headers = {};
    for (const line of originHeaderLines()) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    cfg.xhrSetup = (xhr) => {
      for (const [k, v] of Object.entries(headers)) {
        try {
          xhr.setRequestHeader(k, v);
        } catch {}
      }
      xhr.setRequestHeader('User-Agent', defaultOriginHeaders()['User-Agent']);
    };
  }
  return cfg;
}

// Attach HLS.js to a <video>. Returns a controller. Must be called after the
// video element is mounted.
export function attachHls(videoEl, url, opts = {}) {
  const controller = {
    hls: null,
    native: false,
    errorCount: 0,
    destroyed: false,
    destroy() {
      controller.destroyed = true;
      if (nativeWatchdog) {
        clearInterval(nativeWatchdog);
        nativeWatchdog = null;
      }
      if (controller.hls) {
        controller.hls.destroy();
        controller.hls = null;
      }
      // Fully release the media element so the browser closes the underlying
      // socket to the proxy/origin: pause any active playback, drop the src,
      // and force the source to be forgotten. Without this the <video> can keep
      // the connection "Online" on the panel even after the screen unmounts or
      // the player errors out.
      if (videoEl) {
        try {
          videoEl.pause();
        } catch {}
        videoEl.removeAttribute('src');
        videoEl.src = '';
        try {
          videoEl.load();
        } catch {}
      }
    },
    reloadUrl() {
      controller.errorCount = 0;
      attemptedReload = false;
      doStartPlayback();
    },
  };

  // Route Xtream http:// / .m3u8 media through the external stream proxy
  // (Deno/Vercel), falling back to direct then our Pages Function. Exclusivos
  // streams keep their own proxy + Referer/Origin headers on the native path.
  const candidates = mediaCandidates(url, {
    skipProxy: Boolean(opts.skipProxy),
    isExclusive: Boolean(opts.isExclusive),
  });
  let attempt = 0;

  let attemptedReload = false;
  let manifestLoaded = false;
  let nativeWatchdog = null;
  function doStartPlayback() {
    if (controller.hls) controller.hls.destroy();
    manifestLoaded = false;
    if (nativeWatchdog) {
      clearInterval(nativeWatchdog);
      nativeWatchdog = null;
    }

    const wantsHls = /\.m3u8(\?|$)/i.test(url);
    const scheme = Hls.isSupported();
    const srcUrl = candidates[Math.min(attempt, candidates.length - 1)];

    if (wantsHls && scheme) {
      const hls = new Hls(hlsConfigFor(srcUrl, opts));
      controller.hls = hls;
      hls.loadSource(srcUrl);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data || !data.fatal) return;
        // If the manifest failed to load from this candidate (NETWORK_ERROR
        // before any manifest arrived), try the next route: external proxy ->
        // direct -> CF Pages Function.
        if (attempt < candidates.length - 1 && data.type === Hls.ErrorTypes.NETWORK_ERROR && !manifestLoaded) {
          attempt += 1;
          controller.errorCount = 0;
          doStartPlayback();
          return;
        }
        // DVR / segment stall recovery: reload the manifest up to N times.
        if (controller.errorCount < RECOVERY_ATTEMPTS || attemptedReload) {
          controller.errorCount += 1;
          attemptedReload = true;
          hls.recoverMediaError();
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(controller.errorCount * 500);
        } else if (typeof opts.onError === 'function') {
          opts.onError(data);
        }
      });
      hls.on(Hls.Events.MANIFEST_LOADED, () => {
        manifestLoaded = true;
        if (opts.startPosition && !controller.seeked) {
          // Catchup: jump into the archive (seconds from the DVR edge).
          controller.seeked = true;
          if (videoEl.readyState >= 1) {
            videoEl.currentTime = Math.min(opts.startPosition, videoEl.duration || opts.startPosition);
          } else {
            videoEl.addEventListener(
              'loadedmetadata',
              () => {
                videoEl.currentTime = Math.min(opts.startPosition, videoEl.duration || opts.startPosition);
              },
              { once: true }
            );
          }
        }
      });
    } else {
      // Native playback (or a browser without MSE/HLS). For live Xtream .m3u8
      // some TV browsers handle it natively; VOD uses mp4. Use the preferred
      // (possibly proxied) srcUrl so native <video> also avoids mixed-content.
      controller.native = true;
      videoEl.src = srcUrl;
      if (opts.startPosition) {
        videoEl.addEventListener(
          'loadedmetadata',
          () => {
            videoEl.currentTime = Math.min(opts.startPosition, videoEl.duration || opts.startPosition);
          },
          { once: true }
        );
      }

      // ---- Retry policy for VOD / slow panels -----------------------------
      // A single open attempt is often not enough: panels do 302→CDN and the
      // token can go stale while a multi-hundred-MB mp4 warms up, so the first
      // <video> load sometimes yields nothing. Instead of failing the screen,
      // we RETRY the same route (cache-busted) for that attempt, then try the
      // next proxy, and only surface an error once every route is exhausted.
      const VOD_STALL_MS = 20000; // wait this long before treating a load as stalled
      const MAX_NATIVE_RETRIES = 3; // same-route retries (cache-busted) per candidate
      let nativeRetries = 0;
      let stallFrom = Date.now();

      const fail = () => {
        clearInterval(nativeWatchdog);
        nativeWatchdog = null;
        if (typeof opts.onError === 'function') opts.onError(findMediaError(videoEl));
      };
      const advance = () => {
        // Prefer retrying THIS route with a fresh URL over jumping candidates:
        // transitory 302/403s from a warm-up usually resolve on a reload.
        if (nativeRetries < MAX_NATIVE_RETRIES) {
          nativeRetries += 1;
          stallFrom = Date.now();
          setNativeSrc(/* bustCache */ true);
          return;
        }
        if (attempt < candidates.length - 1) {
          nativeRetries = 0;
          attempt += 1;
          controller.errorCount = 0;
          stallFrom = Date.now();
          doStartPlayback();
          return;
        }
        fail();
      };

      // A hard network/media error on this route → retry once right away (a
      // cache-busted reload often fixes a stale 302/403 from the panel warm-up),
      // then advance to the next candidate on a repeated decisive error.
      const onNativeError = () => {
        if (videoEl.error && nativeRetries < MAX_NATIVE_RETRIES) {
          // One immediate same-route retry; further retries are rate-limited by
          // the stall watchdog so we don't burn them all in one instant.
          nativeRetries += 1;
          stallFrom = Date.now();
          setNativeSrc(/* bustCache */ true);
          return;
        }
        advance();
      };
      videoEl.addEventListener('error', onNativeError);

      // Watchdog: catches silent hangs (no error event) where we never reach
      // metadata. Waits VOD_STALL_MS then advances (retry/next/fail).
      const onNativeWatch = () => {
        if (videoEl.readyState >= 1 || videoEl.error || controller.destroyed) {
          clearInterval(nativeWatchdog);
          nativeWatchdog = null;
          return;
        }
        if (Date.now() - stallFrom >= VOD_STALL_MS) advance();
      };
      nativeWatchdog = setInterval(onNativeWatch, 1000);
    }
    return () => controller.destroy();
  }

  function setNativeSrc(bustCache) {
    const base = candidates[Math.min(attempt, candidates.length - 1)];
    videoEl.src = bustCache ? addNoCache(base) : base;
    // Re-arm the play() the caller/toggle relies on.
    videoEl.load();
    if (opts.startPosition) {
      videoEl.addEventListener(
        'loadedmetadata',
        () => {
          videoEl.currentTime = Math.min(opts.startPosition, videoEl.duration || opts.startPosition);
        },
        { once: true }
      );
    }
  }

  function addNoCache(u) {
    const sep = String(u).includes('?') ? '&' : '?';
    return `${u}${sep}nocache=${Date.now()}`;
  }

  function findMediaError(videoEl) {
    return videoEl.error || new Error('media timeout');
  }

  doStartPlayback();
  return controller;
}

// Derive the HLS .m3u8 URL for a channel from its continuous .ts URL, so we can
// fall back to segmented HLS when mpegts.js can't decode the TS stream.
function tsToHlsUrl(tsUrl) {
  return String(tsUrl || '').replace(/\.ts(?=\?|$)/i, '.m3u8');
}

// Build a continuous-MPEG-TS playback controller for a LIVE channel. Mirrors the
// attachHls controller (destroy / reloadUrl) so Player.jsx treats live and VOD
// uniformly. Routes the .ts through the proxy with &continuous=1 so the VPS
// keeps ONE shared upstream connection to the panel per channel.
//
// Falls back to HLS: if mpegts.js is unsupported on this device OR it emits a
// fatal error while attach/decoding the TS stream (e.g. an MSE/decode failure),
// we automatically switch the same channel to its .m3u8 URL via attachHls. The
// onError callback is only surfaced if the HLS fallback also fails.
export function attachTs(videoEl, url, opts = {}) {
  const candidates = mediaCandidates(url, {
    continuous: true,
    isExclusive: Boolean(opts.isExclusive),
    skipProxy: Boolean(opts.skipProxy),
  });
  const srcUrl = candidates[0];
  const hlsUrl = tsToHlsUrl(url);

  const controller = {
    player: null,
    hls: null, // attachHls controller used for the fallback
    destroyed: false,
    destroy() {
      controller.destroyed = true;
      if (controller.hls) {
        try {
          controller.hls.destroy();
        } catch {}
        controller.hls = null;
      }
      if (controller.player) {
        try {
          controller.player.destroy();
        } catch {}
        controller.player = null;
      }
      // Fully release the media element so the browser closes the socket to the
      // proxy/origin — same wipe as attachHls: pause, drop src, forget it.
      if (videoEl) {
        try {
          videoEl.pause();
        } catch {}
        videoEl.removeAttribute('src');
        videoEl.src = '';
        try {
          videoEl.load();
        } catch {}
      }
    },
    reloadUrl() {
      doStartPlayback();
      return controller;
    },
  };

  function wipeElement() {
    if (!videoEl) return;
    try {
      videoEl.pause();
    } catch {}
    videoEl.removeAttribute('src');
    videoEl.src = '';
    try {
      videoEl.load();
    } catch {}
  }

  function startHls() {
    if (controller.destroyed || !hlsUrl) {
      if (typeof opts.onError === 'function' && !controller.destroyed) opts.onError(new Error('no hls fallback'));
      return;
    }
    controller.hls = attachHls(videoEl, hlsUrl, opts);
  }

  function startTs() {
    if (controller.destroyed) return;
    // No MSE for TS on this device -> HLS segmented fallback.
    if (!mpegts.isSupported() || !mpegts.getFeatureList().mseLivePlayback) {
      startHls();
      return;
    }

    const player = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: srcUrl },
      {
        // FHD/60fps: la demuxación de MPEG-TS corre en un thread secundario
        // para no congelar la UI, con stash y buffer amplios para sostener
        // canales pesados sin descartar frames ni reconectar.
        enableWorker: true,
        enableWorkerForMSE: true,
        isLive: true,
        // Buffering en memoria para absorber picos; inicial 1 MB.
        enableStashBuffer: true,
        stashInitialSize: 1024 * 1024,
        // Sin chasing agresivo. Margen amplio de buffer: máx 12s, mínimo 3s.
        liveBufferLatencyChasing: false,
        liveBufferLatencyMaxLatency: 12,
        liveBufferLatencyMinRemain: 3,
        // Limpia el buffer ya consumido para liberar memoria.
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 10,
        // Conexión hacia el proxy/panel: pedir más por adelantado (20s) para
        // mantener la única .ts compartida abierta y estable.
        lazyLoad: true,
        lazyLoadMaxDuration: 20,
      }
    );
    controller.player = player;

    let fellBack = false;
    const fallback = () => {
      if (controller.destroyed || fellBack) return;
      fellBack = true;
      // Fatal TS error: release the mpegts player + wipe before HLS fallback.
      if (controller.player) {
        try {
          controller.player.destroy();
        } catch {}
        controller.player = null;
      }
      wipeElement();
      startHls();
    };

    player.attachMediaElement(videoEl);
    player.on(mpegts.Events.ERROR, fallback);
    player.load();
    player.play();
  }

  function doStartPlayback() {
    if (controller.hls) {
      try {
        controller.hls.destroy();
      } catch {}
      controller.hls = null;
    }
    if (controller.player) {
      try {
        controller.player.destroy();
      } catch {}
      controller.player = null;
    }
    wipeElement();
    startTs();
  }

  doStartPlayback();
  return controller;
}

// Basic Picture-in-Picture support when available.
export async function togglePip(videoEl) {
  if (!videoEl) return;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (videoEl.requestPictureInPicture) {
      await videoEl.requestPictureInPicture();
    }
  } catch {
    // Not supported / denied by the browser — best effort.
  }
}

// Keep the screen awake while playing when the Wake Lock API is available.
export function wakeLockController() {
  let sentinel = null;
  async function request() {
    if (!('wakeLock' in navigator)) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
    } catch {}
  }
  function release() {
    if (sentinel) {
      sentinel.release().catch(() => {});
      sentinel = null;
    }
  }
  return { request, release };
}

// Try to nudge a stalled live <video> back to the live edge.
export function nudgeToLiveEdge(videoEl) {
  if (!videoEl) return;
  try {
    if (videoEl.seekable && videoEl.seekable.length && Number.isFinite(videoEl.seekable.end(0))) {
      videoEl.currentTime = Math.max(0, videoEl.seekable.end(0) - 2);
    }
  } catch {}
}
