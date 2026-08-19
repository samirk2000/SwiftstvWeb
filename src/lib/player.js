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

// Containers that TV browsers (webOS/Tizen/Vidaa/Android WebView) cannot demux
// natively. IPTV apps bundle their own players (ExoPlayer/VLC) so the same file
// plays there; in-browser we try an .mp4 variant and otherwise surface a clear
// message instead of an endless spinner.
const UNSUPPORTED_CONTAINERS = ['mkv', 'avi', 'flv', 'wmv', 'tsa', 'divx', 'webm', 'ogv', 'mov'];

export function containerExt(url) {
  const m = String(url || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return m ? m[1].toLowerCase() : '';
}

export function isUnsupportedContainer(url) {
  return UNSUPPORTED_CONTAINERS.includes(containerExt(url));
}

// Same URL with the video extension swapped to .mp4, or '' when there is no
// swap candidate (already mp4/hls/ts). Some Xtream panels serve the same file
// regardless of the extension in the URL, so asking for .mp4 can give a
// browser-friendly version of an .mkv/.avi entry.
export function mp4Variant(url) {
  const u = String(url || '');
  const m = u.match(/^(.*\.)([a-z0-9]{2,5})([?#].*)?$/i);
  if (!m) return '';
  const ext = m[2].toLowerCase();
  if (['mp4', 'm3u8', 'ts'].includes(ext)) return '';
  if (!/^(mp4|mkv|avi|flv|wmv|m4v|tsa|divx|webm|ogv|mov)$/.test(ext)) return '';
  return `${m[1]}mp4${m[3] || ''}`;
}

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
  // LIVE (o su fallback HLS): buffer mínimo para que hls.js descargue 1-2
  // segmentos a la vez y NUNCA abra 3+ peticiones paralelas al panel — eso es
  // lo que hace que Xtream detecte varias conexiones y corte la transmisión.
  // VOD/catchup conservan buffer normal (10s) para evitar rebuffering.
  const isLive = Boolean(opts?.isLive);
  const cfg = {
    // Evita workers que disparen fetches en hilos paralelos no controlados.
    enableWorker: false,
    backBufferLength: isLive ? 5 : 30,
    // Live: se sincroniza 2 segmentos detrás del en vivo (máx 4).
    liveSyncDurationCount: isLive ? 2 : 3,
    liveMaxLatencyDurationCount: isLive ? 4 : 5,
    lowLatencyMode: false,
    // Búfer de datos: live 3s por delante (1 segmento) / VOD 10s (pico 15s).
    maxBufferLength: isLive ? 3 : 10,
    maxMaxBufferLength: isLive ? 6 : 15,
    maxBufferSize: 30 * 1024 * 1024,
    // No cortar la carga de un fragmento prematuramente (segmentos de varios MB).
    fragLoadingTimeOut: 30000,
    fragLoadingMaxRetry: isLive ? 3 : 6,
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
      // Detach the native retry/error handlers BEFORE wiping the element: the
      // wipe (pause + load() with an empty src) can fire an `error` event on the
      // <video>, and a still-bound onNativeError would re-arm the src
      // (cache-busted) and restart playback after the screen was left.
      if (nativeErrorBound && videoEl) {
        videoEl.removeEventListener('error', nativeErrorBound);
        nativeErrorBound = null;
      }
      // Fully release the media element so the browser closes the underlying
      // socket to the proxy/origin: pause any active playback, drop the src,
      // and force the source to be forgotten. Without this the <video> can keep
      // the connection "Online" on the panel even after the screen unmounts or
      // the player errors out.
      wipeElement();
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
  // Alternate URLs (e.g. an .mp4 variant of a .mkv entry) are appended as
  // trailing candidates — tried only after every primary route fails, and each
  // is tried sequentially with a full element wipe in between.
  const primary = mediaCandidates(url, {
    skipProxy: Boolean(opts.skipProxy),
    isExclusive: Boolean(opts.isExclusive),
  });
  const candidates = (opts.alternateUrls || []).reduce((acc, alt) => {
    for (const c of mediaCandidates(alt, {
      skipProxy: Boolean(opts.skipProxy),
      isExclusive: Boolean(opts.isExclusive),
    })) {
      if (!acc.includes(c)) acc.push(c);
    }
    return acc;
  }, primary.slice());
  let attempt = 0;

  let attemptedReload = false;
  let manifestLoaded = false;
  let nativeWatchdog = null;
  let nativeErrorBound = null;

  // Shared retry state for the native <video> path (single active route at a
  // time). Lives at controller scope so setNativeSrc can re-bind the error
  // listener after a wipe without hitting a closure ReferenceError.
  const VOD_STALL_MS = 30000; // wait this long before treating a load as stalled
  const MAX_NATIVE_RETRIES = 1; // max same-route cache-busted retries (error + stall combined)
  let nativeRetries = 0;
  let stallFrom = Date.now();

  // Strict element release: pause, forget the source and force the browser to
  // abort any active download (incl. byte-range 206 of VOD) so the connection
  // toward the proxy/panel closes BEFORE a new URL is assigned. Same sequence
  // the Player screen uses on unmount.
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

  function doStartPlayback() {
    if (controller.destroyed) return;
    if (controller.hls) controller.hls.destroy();
    manifestLoaded = false;
    if (nativeWatchdog) {
      clearInterval(nativeWatchdog);
      nativeWatchdog = null;
    }
    if (nativeErrorBound && videoEl) {
      videoEl.removeEventListener('error', nativeErrorBound);
      nativeErrorBound = null;
    }
    // Mono-connection: destroy every previous controller/watchdog and release
    // the element before assigning the (new) source.
    wipeElement();

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
      // Panel-friendly but resilient: a hard error gets ONE cache-busted retry
      // of the SAME route (a stale 302/403 from the panel warm-up often resolves
      // on a fresh request), then advances to the next candidate. A silent stall
      // (no metadata for VOD_STALL_MS) also retries the same route once, then
      // advances. Retries are STRICTLY sequential: setNativeSrc wipes the
      // element first so the previous stream?target= connection closes before
      // the next opens — the panel never sees overlapping connections. The
      // handlers themselves (fail / nextCandidate / onNativeError /
      // onNativeWatch) live at controller scope so setNativeSrc can re-bind the
      // error listener after each wipe.
      nativeRetries = 0;
      stallFrom = Date.now();
      nativeErrorBound = onNativeError;
      videoEl.addEventListener('error', nativeErrorBound);
      nativeWatchdog = setInterval(onNativeWatch, 1000);
    }
    return () => controller.destroy();
  }

  // A hard network/media error on this route: stop the stall watchdog and retry
  // the SAME route once (cache-busted) before advancing. Never a fast loop —
  // capped by MAX_NATIVE_RETRIES and sequential (wipe-first). The `destroyed`
  // guard also ensures a teardown-triggered error event can never restart the
  // stream after the player was left.
  function onNativeError() {
    if (controller.destroyed) return;
    clearInterval(nativeWatchdog);
    nativeWatchdog = null;
    if (nativeRetries < MAX_NATIVE_RETRIES) {
      nativeRetries += 1;
      stallFrom = Date.now();
      setNativeSrc(/* bustCache */ true);
      return;
    }
    nextCandidate();
  }

  // Watchdog: catches silent hangs (no error event) where we never reach
  // metadata. After VOD_STALL_MS, retry the same route once (cache-busted),
  // then advance to the next candidate, and only then surface the error.
  function onNativeWatch() {
    if (videoEl.readyState >= 1 || videoEl.error || controller.destroyed) {
      clearInterval(nativeWatchdog);
      nativeWatchdog = null;
      return;
    }
    if (Date.now() - stallFrom >= VOD_STALL_MS) {
      if (nativeRetries < MAX_NATIVE_RETRIES) {
        nativeRetries += 1;
        stallFrom = Date.now();
        setNativeSrc(/* bustCache */ true);
        return;
      }
      nextCandidate();
    }
  }

  function nextCandidate() {
    if (controller.destroyed) return;
    if (attempt < candidates.length - 1) {
      attempt += 1;
      controller.errorCount = 0;
      doStartPlayback();
      return;
    }
    fail();
  }

  function fail() {
    if (controller.destroyed) return;
    clearInterval(nativeWatchdog);
    nativeWatchdog = null;
    if (nativeErrorBound && videoEl) {
      videoEl.removeEventListener('error', nativeErrorBound);
      nativeErrorBound = null;
    }
    if (typeof opts.onError === 'function') opts.onError(findMediaError(videoEl));
  }

  function setNativeSrc(bustCache) {
    if (controller.destroyed) return;
    // Detach the error handler while we re-arm: the wipe below (pause + load
    // with an emptied src) fires a MEDIA_ERR_SRC_NOT_SUPPORTED 'error' event
    // that must NOT be treated as a playback failure. Re-bind after assigning
    // the new URL so subsequent REAL errors are still caught.
    if (nativeErrorBound && videoEl) {
      videoEl.removeEventListener('error', nativeErrorBound);
      nativeErrorBound = null;
    }
    // Close any in-flight request first so retries never overlap on the panel.
    wipeElement();
    const base = candidates[Math.min(attempt, candidates.length - 1)];
    videoEl.src = bustCache ? addNoCache(base) : base;
    // Re-arm the play() the caller/toggle relies on.
    videoEl.load();
    nativeErrorBound = onNativeError;
    videoEl.addEventListener('error', nativeErrorBound);
    // Re-arm the stall watchdog if the previous handler cleared it: a retried
    // route that silently hangs must still be detected.
    if (!nativeWatchdog) {
      stallFrom = Date.now();
      nativeWatchdog = setInterval(onNativeWatch, 1000);
    }
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
      teardownMpegts();
      wipeElement();
    },
    reloadUrl() {
      doStartPlayback();
      return controller;
    },
  };

  function teardownMpegts() {
    const p = controller.player;
    controller.player = null;
    if (!p) return;
    // Stop the mpegts player explicitly: pause, unload the source, detach the
    // media element, then destroy it — this aborts any in-flight HTTP request
    // and closes the continuous stream/socket toward the proxy.
    try { p.pause(); } catch {}
    try { p.unload(); } catch {}
    try { p.detachMediaElement(); } catch {}
    try { p.destroy(); } catch {}
  }

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

    // LIVE (TV en vivo) vs VOD/archivo: la configuración del motor cambia por
    // completo. Para live usamos baja latencia + mono-conexión estricta (el
    // panel de Xtream corta la sesión si ve >N conexiones simultáneas), con un
    // stash holgado para un arranque estable: si el stash es mínimo, el
    // demuxer apenas retiene bytes y el chasing agresivo deja el buffer en
    // seco cada pocos segundos (stuttering). 384KB aseguran un arranque fluido
    // y un margen de 8s con mínimo de 3s evita los saltos que causan el trabo.
    const isLive = opts.isLive !== false;
    const player = mpegts.createPlayer(
      { type: 'mpegts', isLive, url: srcUrl, cors: true },
      isLive
        ? {
            // Demux en thread secundario para no congelar la UI.
            enableWorker: true,
            enableWorkerForMSE: true,
            isLive: true,
            // Stash holgado: retiene hasta encontrar el primer keyframe H.264
            // (SPS/PPS) y arranca el demuxer en MSE con margen inicial.
            enableStashBuffer: true,
            stashInitialSize: 384 * 1024,
            // Auto-ajustar latencia sin reabrir conexiones: permite hasta 8s
            // de margen en vivo y mantiene SIEMPRE 3s de buffer mínimo, de
            // modo que el video nunca se queda en seco. Nunca re-consulta la URL.
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 8,
            liveBufferLatencyMinRemain: 3,
            // Limpia la memoria del buffer consumido sin reconectar.
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 30,
            autoCleanupMinBackwardDuration: 10,
            // Sin prefetch por delante del borde en vivo.
            lazyLoad: false,
            deferLoadAfterSourceOpen: false,
          }
        : {
            // VOD / archivo: stash pequeño para arranque rápido y sin chasing.
            enableWorker: true,
            enableWorkerForMSE: true,
            isLive: false,
            enableStashBuffer: true,
            stashInitialSize: 128 * 1024,
            liveBufferLatencyChasing: false,
            lazyLoad: false,
            deferLoadAfterSourceOpen: false,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 30,
            autoCleanupMinBackwardDuration: 10,
          }
    );
    controller.player = player;

    let fellBack = false;
    const fallback = () => {
      if (controller.destroyed || fellBack) return;
      fellBack = true;
      // Fatal TS error: release the mpegts player + wipe before HLS fallback.
      teardownMpegts();
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
    teardownMpegts();
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
