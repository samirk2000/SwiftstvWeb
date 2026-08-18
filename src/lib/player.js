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
export function mediaCandidates(url, { skipProxy = false, isExclusive = false } = {}) {
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
  return streamProxyCandidates(url);
}

// Legacy single-URL helper: returns the preferred (first) candidate.
export function proxyMediaUrl(url, opts = {}) {
  return mediaCandidates(url, opts)[0];
}

// Determine the HLS.js config (extraOrigin applies dynamic Referer/Origin).
function hlsConfigFor(url, opts) {
  const cfg = {
    enableWorker: false, // Worker-less is safer across TV webviews.
    backBufferLength: 60,
    liveSyncDurationCount: 3,
    // Priorizar estabilidad sobre latencia baja: los segmentos de ~2.9 MB tardan
    // en cruzar el proxy, así que ampliamos el búfer y desactivamos el modo de
    // baja latencia para evitar agotamiento del búfer / congelamientos.
    lowLatencyMode: false,
    // Búfer de datos (segundos / bytes) para absorber conectividades lentas.
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    maxBufferSize: 60 * 1024 * 1024,
    // No cortar la carga de un fragmento prematuramente (segmentos de varios MB).
    fragLoadingTimeOut: 30000,
    fragLoadingMaxRetry: 6,
    // Manifests via a slow proxy can stall too — hold them longer and retry more.
    manifestLoadingTimeOut: 15000,
    manifestLoadingMaxRetry: 4,
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
      if (videoEl) videoEl.removeAttribute('src');
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
      // Try the NEXT candidate when a native request errors out (e.g. a proxy
      // answers 403 for this panel) — a different proxy/direct route may work.
      // A single decisive error moves on; transient stalls are retried below.
      const onNativeError = () => {
        if (attempt < candidates.length - 1) {
          attempt += 1;
          controller.errorCount = 0;
          doStartPlayback();
        } else if (typeof opts.onError === 'function') {
          opts.onError(videoEl.error);
        }
      };
      videoEl.addEventListener('error', onNativeError);
      // Watchdog: some CDNs/proxies hang the first <video> request with zero
      // bytes (no error event ever fires) while the panel does its 302 → CDN and
      // starts serving a large mp4. VOD files (hundreds of MB through a proxy)
      // can take well over 8s to reach HAVE_METADATA, so we wait much longer
      // before treating it as a failure, and RETRY the same route a few times
      // (with a cache-buster) instead of aborting on the first slow load.
      const VOD_STALL_MS = 20000;
      const MAX_NATIVE_RETRIES = 2;
      let nativeRetries = 0;
      let stallFrom = Date.now();
      const onNativeWatch = () => {
        if (videoEl.readyState >= 1 || videoEl.error || controller.destroyed) {
          clearInterval(nativeWatchdog);
          nativeWatchdog = null;
          return;
        }
        if (Date.now() - stallFrom < VOD_STALL_MS) return;
        // No metadata after VOD_STALL_MS → try to keep it alive instead of aborting.
        stallFrom = Date.now(); // open a fresh window for the next wait
        if (nativeRetries < MAX_NATIVE_RETRIES) {
          // Reload the SAME route with a cache-buster: slow panels are often
          // transitory (the 302 token goes stale while the CDN warms up), and a
          // reload frequently starts the stream whereas another proxy may hit a
          // fresh slow start.
          nativeRetries += 1;
          setNativeSrc(/* bustCache */ true);
          return;
        }
        if (attempt < candidates.length - 1) {
          // This route is genuinely dead after retries → try the next proxy.
          clearInterval(nativeWatchdog);
          nativeWatchdog = null;
          nativeRetries = 0;
          attempt += 1;
          controller.errorCount = 0;
          doStartPlayback();
          return;
        }
        clearInterval(nativeWatchdog);
        nativeWatchdog = null;
        if (typeof opts.onError === 'function') opts.onError(findMediaError(videoEl));
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
