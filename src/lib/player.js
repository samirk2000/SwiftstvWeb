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

const RECOVERY_ATTEMPTS = 3;

export function buildSrcUrl(url, opts = {}) {
  return url;
}

// Xtream live/VOD/series panels hand back `http://` stream URLs and redirect
// even their `https://` manifests to an `http://IP:port` CDN. A browser loading
// them from our HTTPS page blocks those as mixed active content. Route every
// non-Exclusivos `.m3u8` (and any `http://` media) through our own `/proxy`
// Pages Function, which follows the redirects and rewrites the playlist server
// side, so the whole stream stays on HTTPS. Exclusivos streams (which need
// dynamic Referer/Origin headers and their own proxy) are left untouched.
export function proxyMediaUrl(url, { skipProxy = false, isExclusive = false } = {}) {
  if (skipProxy || isExclusive) return url;
  const lu = String(url || '').toLowerCase();
  if (!lu) return url;
  if (lu.startsWith('/proxy')) return url; // already routed
  const isHls = /\.m3u8(\?|$)/i.test(lu);
  const isHttp = lu.startsWith('http:');
  if (!isHls && !isHttp) return url; // https media on our origin or remote CDN
  const targetUrl = new URL(url, window.location.origin).toString();
  return `/proxy?target=${encodeURIComponent(targetUrl)}`;
}

// Determine the HLS.js config (extraOrigin applies dynamic Referer/Origin).
function hlsConfigFor(url, opts) {
  const cfg = {
    enableWorker: false, // Worker-less is safer across TV webviews.
    backBufferLength: 60,
    liveSyncDurationCount: 3,
    // Cache-busting of the manifest so DVR buffers don't go stale after stalls.
    maxBufferLength: 60,
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
    destroy() {
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

  // Route http:// / Xtream .m3u8 through our /proxy so an HTTPS page never hits
  // mixed-content blocks. Exclusivos streams already carry their own proxy +
  // Referer/Origin headers, so leave them on the native path.
  const srcUrl = proxyMediaUrl(url, {
    skipProxy: Boolean(opts.skipProxy),
    isExclusive: Boolean(opts.isExclusive),
  });

  let attemptedReload = false;
  function doStartPlayback() {
    if (controller.hls) controller.hls.destroy();

    const wantsHls = /\.m3u8(\?|$)/i.test(url);
    const scheme = Hls.isSupported();

    if (wantsHls && scheme) {
      const hls = new Hls(hlsConfigFor(srcUrl, opts));
      controller.hls = hls;
      hls.loadSource(srcUrl);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data || !data.fatal) return;
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
      // some TV browsers handle it natively; VOD uses mp4. Use the (possibly
      // proxied) srcUrl so native <video> also avoids mixed-content blocks.
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
      if (typeof opts.onNativeError === 'function') {
        videoEl.addEventListener('error', opts.onNativeError, { once: true });
      }
    }
    return () => controller.destroy();
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
