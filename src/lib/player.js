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
export function mediaCandidates(url, { skipProxy = false, isExclusive = false, continuous = false, liveFallback = false } = {}) {
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
  const opts = {};
  if (continuous) opts.continuous = true;
  // LIVE HLS FALLBACK uses a single-route (mono-connection) candidate list so
  // hls.js never probes multiple proxies at once on a slow live channel — that's
  // what kept several connections alive on the panel and flooded the network tab.
  if (liveFallback) opts.liveFallback = true;
  return streamProxyCandidates(url, opts);
}

// Legacy single-URL helper: returns the preferred (first) candidate.
export function proxyMediaUrl(url, opts = {}) {
  return mediaCandidates(url, opts)[0];
}

// Determine the HLS.js config (extraOrigin applies dynamic Referer/Origin).
function hlsConfigFor(url, opts) {
  // VOD/catchup: buffer normal (10s por delante) para evitar rebuffering.
  // LIVE FALLBACK (isLiveFallback): es el único camino HLS para live y suelen
  // ser canales que mpegts no pudo reproducir y cuyo CDN HLS es LENTO (p. ej.
  // segmentos de 3.3MB que bajan en 8-10s, casi a la velocidad de reproducción).
  // La config "normal" abortaba el fragmento lento y recargaba el playlist en
  // bucle. Para estos canales damos margen: NO abortar fragmentos (timeout 60s),
  // algo más de buffer por delante, manteniendo la sincronía en vivo de 3
  // segmentos. Pero es una ruta MONO-CONEXIÓN (mediaCandidates devuelve un solo
  // proxy), así que limitamos los reintentos por fragmento/manifiesto: cuando un
  // canal lento se traba, más reintentos solo abren más sockets al panel/CDN y
  // disparan la oleada de peticiones (panel mostrando 3 conexiones simultáneas).
  // Un reintento moderado + la conmutación por el watchdog de liveness (y el
  // botón Reintentar) bastan; no convierten un canal con CDN rota en una tormenta.
  const isLiveFallback = Boolean(opts?.isLiveFallback);
  const cfg = {
    // Evita workers que disparen fetches en hilos paralelos no controlados.
    enableWorker: false,
    backBufferLength: isLiveFallback ? 20 : 30,
    // Live: se sincroniza 3 segmentos detrás del en vivo (máx 5).
    liveSyncDurationCount: isLiveFallback ? 3 : 3,
    liveMaxLatencyDurationCount: isLiveFallback ? 5 : 5,
    lowLatencyMode: false,
    // Búfer de datos por delante (pico), 30MB en RAM.
    maxBufferLength: isLiveFallback ? 15 : 10,
    maxMaxBufferLength: isLiveFallback ? 30 : 15,
    maxBufferSize: 30 * 1024 * 1024,
    // No cortar la carga de un fragmento prematuramente (segmentos de varios MB
    // en CDN lentas pueden tardar 20-40s; 60s de margen).
    fragLoadingTimeOut: isLiveFallback ? 60000 : 30000,
    // Live fallback = un solo reintento de fragmento; VOD conserva los suyos.
    fragLoadingMaxRetry: isLiveFallback ? 2 : 6,
    // Manifests .m3u8 vía proxy lento: timeout 10s y reintentos moderados.
    manifestLoadingTimeOut: 10000,
    manifestLoadingMaxRetry: isLiveFallback ? 3 : 3,
    levelLoadingTimeOut: 20000,
    levelLoadingMaxRetry: isLiveFallback ? 2 : 4,
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
    liveFallback: Boolean(opts.isLiveFallback),
  });
  const candidates = (opts.alternateUrls || []).reduce((acc, alt) => {
    for (const c of mediaCandidates(alt, {
      skipProxy: Boolean(opts.skipProxy),
      isExclusive: Boolean(opts.isExclusive),
      liveFallback: Boolean(opts.isLiveFallback),
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
    fellBack: false,
    destroyed: false,
    destroy() {
      controller.destroyed = true;
      clearWatchdogs();
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

  // ---- Liveness watchdogs (fallback a HLS si el video no avanza) ----------
  // Algunos canales se CONECTAN en el panel/proxy y descargan sin parar, pero
  // mpegts.js no logra reproducirlos y NO emite error:
  //  - sin keyframe decodificable → no llegan frames → no arranca;
  //  - keyframes que SÍ decodifican pero el playback no avanza → el <video>
  //    renderiza un "slideshow": la imagen cambia cada GOP (~10s) mientras
  //    currentTime está congelado y readyState puede quedar ALTO porque MSE
  //    sigue recibiendo datos. Una comprobación de readyState no basta.
  // Por eso ambos watchdogs miden el AVANCE de currentTime de forma continua:
  // si no avanza ≥LIVENESS_ADVANCE_DELTA durante `stallMs` consecutivos (tanto
  // en el arranque como a mitad de reproducción), la ruta actual está rota para
  // ese canal. Fase mpegts → teardown del reproductor continuo (cierra la
  // conexión) y conmutar a HLS .m3u8 (la vía que usaban esos canales antes de
  // la migración a TS). Fase HLS → reportar el error real (codec/red) para
  // salir de "Cargando" infinito con pantalla de error/Reintentar. Una pausa
  // intencional del usuario no cuenta como atasco.
  const LIVENESS_SAMPLE_MS = 2000;
  const LIVENESS_ADVANCE_DELTA = 0.5; // avance mínimo por muestra para "vivo"
  const MPEGTS_STALL_MS = 12000; // sin avance durante 12s con mpegts → HLS
  // Pausa entre el teardown del TS continuo y el arranque del HLS .m3u8: el
  // worker de mpegts deja el elemento en estado transitorio (los errores
  // "Worker MediaSource attachment is closing" de la consola) y el panel
  // tarda unos segundos en LIBERAR la conexión continua del .ts. Si el .m3u8
  // llega mientras el panel aún cuenta esa sesión, los segmentos bajan
  // limitados (3.3MB en 8-10s) y hls.js nunca alcanza el borde en vivo:
  // aborta el fragmento lento, recarga el playlist en bucle y no reproduce.
  const HLS_START_DELAY_MS = 3000;
  let startupWatchdog = null;
  let fallbackWatchdog = null;
  let hlsDelayTimer = null;
  function clearWatchdogs() {
    if (startupWatchdog) {
      clearInterval(startupWatchdog);
      startupWatchdog = null;
    }
    if (fallbackWatchdog) {
      clearInterval(fallbackWatchdog);
      fallbackWatchdog = null;
    }
    if (hlsDelayTimer) {
      clearTimeout(hlsDelayTimer);
      hlsDelayTimer = null;
    }
  }
  // Vigila que currentTime avance de forma continua. Si no avanza durante
  // `stallMs` consecutivos, invoca `onGiveUp`. Cubre tanto el arranque (nunca
  // avanzó) como un congelamiento posterior.
  //
  // PAUSA en vivo: el reproductor live NO tiene botón de pausa (solo PiP/atrás),
  // así que una `videoEl.paused` en reproducción en vivo casi siempre es un
  // ATASCO/fallo (el navegador pausa al quedarse sin buffer) y no una acción del
  // usuario. Antes esto se trataba como "pausa intencional" y reseteaba el
  // watchdog: un stream trabado que pausaba quedaba congelado PARA SIEMPRE, sin
  // conmutar a HLS ni cerrar la conexión — el panel lo seguía marcando "Online"
  // y la app se quedaba en "Cargando" sin reanudar. Para live, `paused` cuenta
  // como atasco (el teardown/fallback cerrará la conexión); solo en VOD/archivo
  // (donde sí hay pausa real) se respeta como pausa intencional.
  function livenessWatch(stallMs, onGiveUp) {
    if (!videoEl || controller.destroyed) return null;
    const isLive = opts.isLive !== false;
    let lastAdvanceAt = Date.now();
    let lastT = videoEl.currentTime || 0;
    return setInterval(() => {
      if (controller.destroyed) {
        clearWatchdogs();
        return;
      }
      const t = videoEl.currentTime || 0;
      const advanced = t - lastT >= LIVENESS_ADVANCE_DELTA;
      const isPauseFault = videoEl.paused && isLive; // live pause = atasco
      if ((advanced && !isPauseFault) || (videoEl.paused && !isLive)) {
        // Reproduciendo de verdad (avanza) o pausa intencional (solo VOD): reset.
        lastAdvanceAt = Date.now();
        lastT = t;
      } else if (Date.now() - lastAdvanceAt >= stallMs) {
        clearWatchdogs();
        onGiveUp();
      }
    }, LIVENESS_SAMPLE_MS);
  }
  function armStartupWatchdog() {
    startupWatchdog = livenessWatch(MPEGTS_STALL_MS, () =>
      fallbackToHls('no playback advance')
    );
  }
  // Fases del fallback HLS: el arranque en CDN lenta es LEGÍTIMO y puede tardar
  // 30-50s (acumular buffer de 3 segmentos bajando casi a velocidad 1:1). Por
  // eso no cortamos pronto: fase 1 vigila HLS_FIRST_RETRY_MS y si no avanzó hace
  // UN reintento limpio (destruye el Hls anterior, limpia el elemento y vuelve a
  // adjuntar); fase 2 vigila HLS_STALL_MS y si sigue sin avanzar reporta el
  // error real con diagnóstico. En total hasta ~90s antes de dar el fallo.
  const HLS_FIRST_RETRY_MS = 45000;
  const HLS_STALL_MS = 45000;
  let hlsRetryCount = 0;
  function armFallbackWatchdog() {
    if (hlsRetryCount === 0) {
      fallbackWatchdog = livenessWatch(HLS_FIRST_RETRY_MS, () => {
        hlsRetryCount += 1;
        retryHls();
        armFallbackWatchdog();
      });
    } else {
      fallbackWatchdog = livenessWatch(HLS_STALL_MS, () => {
        // Diagnóstico: distinguir "no llegan datos" de "llegan pero no decodifica".
        // eslint-disable-next-line no-console
        console.warn('[attachTs] fallback HLS estancado', {
          readyState: videoEl?.readyState,
          paused: videoEl?.paused,
          currentTime: videoEl?.currentTime,
          bufferedRanges: videoEl?.buffered ? videoEl.buffered.length : 0,
          videoError: videoEl?.error
            ? { code: videoEl.error.code, message: videoEl.error.message }
            : null,
        });
        // Si ni siquiera HLS reproduce este canal, olvida la preferencia HLS
        // para que un Reintentar vuelva a probar mpegts (auto-curación).
        if (typeof opts.onHlsFail === 'function') {
          try {
            opts.onHlsFail();
          } catch {}
        }
        if (typeof opts.onError === 'function') opts.onError(new Error('hls fallback stalled'));
      });
    }
  }

  function startHls() {
    clearWatchdogs();
    if (controller.destroyed || !hlsUrl) {
      if (typeof opts.onError === 'function' && !controller.destroyed) opts.onError(new Error('no hls fallback'));
      return;
    }
    // eslint-disable-next-line no-console
    console.info('[attachTs] HLS fallback url=%s', hlsUrl);
    controller.hls = attachHls(videoEl, hlsUrl, { ...opts, isLiveFallback: true });
  }

  // Reintento limpio del HLS: un attach fresco suele pasar de un primer intento
  // que dejó el elemento/manifiesto en mal estado (transición desde el worker
  // de mpegts, primer playlist incompleto, CDN aún calentando).
  function retryHls() {
    if (controller.destroyed) return;
    if (controller.hls) {
      try {
        controller.hls.destroy();
      } catch {}
      controller.hls = null;
    }
    wipeElement();
    // eslint-disable-next-line no-console
    console.warn('[attachTs] reintento HLS #%d', hlsRetryCount);
    startHls();
  }

  // Conmutar del TS continuo al HLS .m3u8. Se usa para: error fatal de mpegts,
  // MSE no soportado, o watchdog de liveness (canal que conecta en el panel
  // pero mpegts no produce playback). Libera el reproductor mpegts y el
  // elemento ANTES de asignar la URL HLS, y espera HLS_START_DELAY_MS para que
  // el panel libere la conexión continua y el elemento termine de desprenderse
  // del MediaSource del worker (ver comentario de la constante).
  function fallbackToHls(reason) {
    if (controller.destroyed || controller.fellBack) return;
    controller.fellBack = true;
    clearWatchdogs();
    // eslint-disable-next-line no-console
    console.warn('[attachTs] fallback a HLS:', reason || 'error mpegts');
    // Recuerda el canal como "HLS-only" para que el próximo zap vaya directo a
    // HLS (mpegts no puede reproducir este canal en este navegador).
    if (typeof opts.onHlsFallback === 'function') {
      try {
        opts.onHlsFallback();
      } catch {}
    }
    teardownMpegts();
    wipeElement();
    hlsDelayTimer = setTimeout(() => {
      hlsDelayTimer = null;
      if (controller.destroyed) return;
      startHls();
      armFallbackWatchdog();
    }, HLS_START_DELAY_MS);
  }

  function startTs() {
    if (controller.destroyed) return;
    // Preferencia persistida del canal (memoria "HLS-only"): si un canal ya cayó
    // al fallback HLS en un navegador donde mpegts nunca reproduce el .ts, la
    // próxima vez vamos DIRECTOS a HLS — sin esperar el watchdog de 12s ni
    // arriesgar una transición MSE sucia (que dejaba el fallback sin reproducir).
    if (opts.preferHls) {
      startHls();
      armFallbackWatchdog();
      return;
    }
    // No MSE for TS on this device -> HLS segmented fallback.
    if (!mpegts.isSupported() || !mpegts.getFeatureList().mseLivePlayback) {
      startHls();
      armFallbackWatchdog();
      return;
    }

    // LIVE (TV en vivo) vs VOD/archivo: la configuración del motor cambia por
    // completo. Para live usamos baja latencia + mono-conexión estricta (el
    // panel de Xtream corta la sesión si ve >N conexiones simultáneas), con un
    // stash holgado para un arranque estable. El chasing de latencia va
    // DESACTIVADO: el chaser de mpegts.js hace un direct-seek en el <video>
    // (`currentTime = buffered_end - minRemain`) cada vez que el buffer
    // adelantado supera `liveBufferLatencyMaxLatency`; como el proxy entrega
    // más rápido que el tiempo real y el stash crece con la velocidad medida
    // (por eso el trabo empezaba tras ~1 min), ese seek se disparaba cada
    // ~10s y congelaba el video un instante (stutter). Sin chasing el video
    // avanza continuo, sin saltos; la latencia queda en lo que el buffer
    // natural acumule (típicamente pocos segundos, y el stash está acotado).
    const isLive = opts.isLive !== false;
    // eslint-disable-next-line no-console
    console.info('[attachTs] mpegts start (isLive=%s) url=%s', isLive, srcUrl);
    const player = mpegts.createPlayer(
      { type: 'mpegts', isLive, url: srcUrl, cors: true },
      isLive
        ? {
            // Demux + MSE en el hilo principal: el worker dedicado de mpegts
            // (`enableWorkerForMSE:true`) fallaba SILENCIOSAMENTE en algunos
            // navegadores/TV (logs llenos de "Worker MediaSource attachment is
            // closing" y NINGUNA petición .ts saliendo del reproductor). Con el
            // worker desactivado, el .ts continuo se solicita y decodifica de
            // forma fiable; el costo de UI es despreciable en hilos modernos.
            enableWorker: false,
            enableWorkerForMSE: false,
            isLive: true,
            // Stash holgado: retiene hasta encontrar el primer keyframe H.264
            // (SPS/PPS) y suaviza picos de red. El tamaño se adapta a la
            // velocidad medida (máx 8MB), por eso el arranque con 512KB.
            enableStashBuffer: true,
            stashInitialSize: 512 * 1024,
            // Chasing desactivado (ver comentario del bloque): sin direct-seeks
            // periódicos no hay trabo cada 10s. Los valores de margen quedan
            // como tope por si se reactiva.
            liveBufferLatencyChasing: false,
            liveBufferLatencyMaxLatency: 12,
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
            enableWorker: false,
            enableWorkerForMSE: false,
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

    player.attachMediaElement(videoEl);
    player.on(mpegts.Events.ERROR, () => fallbackToHls('mpegts ERROR'));
    player.load();
    player.play();
    // Vigila la reproducción de forma continua: si currentTime no avanza en
    // MPEGTS_STALL_MS (no llegan frames o se queda en "slideshow" sin
    // reproducir), conmuta a HLS.
    armStartupWatchdog();
  }

  function doStartPlayback() {
    if (controller.hls) {
      try {
        controller.hls.destroy();
      } catch {}
      controller.hls = null;
    }
    // Reset del flag y del contador de reintentos HLS para que un
    // reloadUrl/reintento vuelva a caer a HLS desde cero si hace falta.
    controller.fellBack = false;
    hlsRetryCount = 0;
    clearWatchdogs();
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
