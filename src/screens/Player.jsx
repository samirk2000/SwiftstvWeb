import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { attachHls, attachTs, isUnsupportedContainer, mp4Variant, togglePip, wakeLockController } from '../lib/player.js';
import { needsOriginHeaders } from '../lib/exclusivos.js';
import {
  updateContinueWatching,
  isHlsOnlyChannel,
  markHlsOnlyChannel,
  clearHlsOnlyChannel,
  getSession,
} from '../lib/session.js';
import { setFocused } from '../components/Focusable.jsx';
import { getPrefs } from '../lib/prefs.js';
import { zapRelative, zapByNumber, setLastLiveChannel } from '../lib/liveZap.js';
import { getSeriesInfo, seriesStreamUrl } from '../lib/xtream.js';

export default function Player() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);

  const url = params.get('url');
  const type = params.get('type') || 'live';
  const id = params.get('id') || '';
  const title = params.get('title') || (type === 'live' ? t('live.title') : '');
  const startPosition = Number(params.get('start') || 0) || 0;
  const seriesId = params.get('seriesId') || '';
  const seasonParam = params.get('season') || '';

  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const wakeRef = useRef(null);
  const hideTimer = useRef(null);
  // Strict single-flight AbortController: only ONE outstanding request load is
  // allowed at a time. Before starting a NEW stream (or on error/pause/unmount)
  // we abort the previous controller so no parallel fetch keeps the panel at
  // 4/3 connections.
  const abortRef = useRef(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [error, setError] = useState(false);
  // MEDIA_ERR_* code when playback failed (4 = src not supported / codec).
  const [errorCode, setErrorCode] = useState(null);
  const [started, setStarted] = useState(false);
  // True when autoplay-with-sound was blocked and we fell back to muted playback
  // (direct link / strict browser policy). Shows an unmute hint.
  const [mutedHint, setMutedHint] = useState(false);
  // Bumped by the manual Retry button so the [url] effect re-runs and rebuilds
  // the player from scratch (destroying any previous controller first). Also
  // used as the <video> `key`, so a rebuild mounts a FRESH media element — the
  // mpegts→HLS fallback on a used element can leave the MSE in a broken state
  // on some browsers (segments download but playback never starts).
  const [restart, setRestart] = useState(0);
  // Mirrors `started` for use inside effect closures (avoid stale state).
  const startedRef = useRef(false);
  // Coalesces the "mpegts TS reproduces this channel" signal so we clear the
  // HLS-only memory exactly once per mount (called from both `playing` and, as a
  // fallback for webviews that never fire `playing`, from `timeupdate`).
  const hlsClearedRef = useRef(false);

  // VOD / series / catchup get scrubber + pause/seek. Live stays zap-only.
  const isVodLike = type === 'vod' || type === 'series' || type === 'catchup';
  const isLive = type === 'live';
  const [paused, setPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [zapBanner, setZapBanner] = useState('');
  const [numBuffer, setNumBuffer] = useState('');
  const numTimer = useRef(null);
  const prefs = getPrefs();
  const seekJump = Number(prefs.seekJump) || 30;
  const controlsVisibleRef = useRef(controlsVisible);
  controlsVisibleRef.current = controlsVisible;
  const lastSeekAtRef = useRef(0);
  const SEEK_COOLDOWN_MS = 650;
  const pauseBtnRef = useRef(null);

  // Claim keys from global TV nav while player is active.
  useEffect(() => {
    if (leaveOpen) {
      delete document.documentElement.dataset.tvPlayerKeys;
      return undefined;
    }
    if (isVodLike) document.documentElement.dataset.tvPlayerKeys = 'vod';
    else if (isLive) document.documentElement.dataset.tvPlayerKeys = 'live';
    else delete document.documentElement.dataset.tvPlayerKeys;
    return () => {
      delete document.documentElement.dataset.tvPlayerKeys;
    };
  }, [isVodLike, isLive, leaveOpen]);

  // When the transport bar appears, park focus on Pause — never on Atrás.
  useEffect(() => {
    if (!isVodLike || !controlsVisible || leaveOpen) return undefined;
    const timer = window.setTimeout(() => {
      if (pauseBtnRef.current) setFocused(pauseBtnRef.current, { native: false });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [isVodLike, controlsVisible, leaveOpen]);

  const goLiveChannel = (ch) => {
    if (!ch?.url) return;
    setLastLiveChannel(ch.id);
    setZapBanner(ch.name || ch.id);
    window.setTimeout(() => setZapBanner(''), 2500);
    navigate(
      `/player?type=live&id=${encodeURIComponent(ch.id)}&url=${encodeURIComponent(ch.url)}&title=${encodeURIComponent(
        ch.name || ''
      )}`,
      { replace: true }
    );
  };

  const playNextEpisode = async () => {
    if (type !== 'series' || !seriesId) return false;
    const saved = getSession();
    if (!saved) return false;
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    const info = await getSeriesInfo(srv, seriesId);
    if (!info?.episodes) return false;
    const seasons = Object.keys(info.episodes || {}).sort((a, b) => Number(a) - Number(b));
    let season = seasonParam || seasons[0];
    let list = info.episodes[season] || [];
    let idx = list.findIndex((ep) => String(ep.id) === String(id));
    let next = idx >= 0 ? list[idx + 1] : null;
    if (!next) {
      const sIdx = seasons.indexOf(String(season));
      if (sIdx >= 0 && sIdx < seasons.length - 1) {
        season = seasons[sIdx + 1];
        list = info.episodes[season] || [];
        next = list[0];
      }
    }
    if (!next) return false;
    const container = next.container_extension || info.container_extension || 'mp4';
    const nextUrl = seriesStreamUrl(srv, container, next, season, seriesId);
    const epNum = next.episode_num ? `E${next.episode_num}` : '';
    const nextTitle =
      next.title ||
      [info.info?.name, `T${season}`, epNum].filter(Boolean).join(' · ') ||
      String(next.id);
    navigate(
      `/player?type=series&id=${next.id}&seriesId=${seriesId}&season=${encodeURIComponent(
        String(season)
      )}&url=${encodeURIComponent(nextUrl)}&title=${encodeURIComponent(nextTitle)}`,
      { replace: true }
    );
    return true;
  };

  // Live channel memory: once a channel fell back to HLS (mpegts can't play its
  // .ts on this browser), remember it so the next zap goes straight to HLS —
  // skipping the 12s mpegts watchdog and the dirty MSE teardown. Cleared if the
  // HLS fallback itself fails (a Retry then re-tries mpegts).
  const channelKey = type === 'live' ? `live:${id}` : '';
  const preferHls = type === 'live' && isHlsOnlyChannel(channelKey);

  // For VOD/series entries stored as .mkv/.avi/... the TV browser cannot demux
  // them. Try the SAME id as .mp4 as a trailing candidate (many Xtream panels
  // serve the same file regardless of extension), and surface a clear message
  // when even that fails.
  const mp4Alt = mp4Variant(url);
  const alternateUrls = mp4Alt && mp4Alt !== url ? [mp4Alt] : [];
  const unsupportedContainer = isUnsupportedContainer(url);

  // Wipe the media element and abort any in-flight request, releasing the
  // socket to the panel. Call on error, pause / unmount, or before a new stream.
  const wipePlayback = () => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch {}
      abortRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try { video.pause(); } catch {}
      // Force the element to drop the source AND forget it — the connection to
      // the proxy/origin is closed so the panel stops marking it "Online".
      // removeAttribute('src') before load() cancels any active download,
      // incl. byte-range (206) requests of VOD/movies/series.
      video.removeAttribute('src');
      video.src = '';
      try { video.load(); } catch {}
    }
  };

  // 'p' toggles PiP. VOD is intentionally "slow": first D-pad/OK only opens the
  // bar; seek/pause need the bar visible. Ignores key-repeat so holding ←/→
  // does not rocket through the movie.
  useEffect(() => {
    const bumpControls = () => {
      setControlsVisible(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setControlsVisible(false), 6000);
    };

    const seekBy = (delta) => {
      const v = videoRef.current;
      if (!v || !isVodLike) return;
      const now = Date.now();
      if (now - lastSeekAtRef.current < SEEK_COOLDOWN_MS) return;
      lastSeekAtRef.current = now;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const next = Math.max(0, Math.min(dur || Infinity, (v.currentTime || 0) + delta));
      try {
        v.currentTime = next;
      } catch {
        /* ignore */
      }
      setCurrentTime(next);
      bumpControls();
    };

    const togglePlay = () => {
      const v = videoRef.current;
      if (!v || !isVodLike) return;
      if (v.paused) {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        setPaused(false);
      } else {
        try {
          v.pause();
        } catch {
          /* ignore */
        }
        setPaused(true);
      }
      bumpControls();
    };

    const requestLeave = () => {
      if (isVodLike) {
        setLeaveOpen(true);
        setControlsVisible(true);
        return;
      }
      navigate(-1);
    };

    /** First press only wakes the OSD — no seek/pause yet. */
    const wakeOnly = () => {
      bumpControls();
    };

    const onKey = (e) => {
      if (e.key === 'p' || e.key === 'P') {
        togglePip(videoRef.current);
        return;
      }

      // While leave dialog is open, don't steal arrows for seeking.
      if (leaveOpen) return;

      const code = e.keyCode || e.which || 0;
      const isBack =
        e.key === 'Escape' ||
        e.key === 'BrowserBack' ||
        e.key === 'GoBack' ||
        code === 461 ||
        code === 27;

      if (isBack) {
        e.preventDefault();
        e.stopImmediatePropagation();
        requestLeave();
        return;
      }

      const claim = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };

      // ---- LIVE: CH+/−, numbers, OK shows OSD ----
      if (isLive) {
        const isChUp =
          e.key === 'ChannelUp' ||
          e.key === 'PageUp' ||
          e.key === 'ArrowUp' ||
          code === 427 ||
          code === 33 ||
          code === 38;
        const isChDown =
          e.key === 'ChannelDown' ||
          e.key === 'PageDown' ||
          e.key === 'ArrowDown' ||
          code === 428 ||
          code === 34 ||
          code === 40;
        const digit = /^[0-9]$/.test(e.key || '') ? e.key : code >= 48 && code <= 57 ? String(code - 48) : '';

        if (e.repeat && (isChUp || isChDown || digit)) {
          claim();
          return;
        }
        if (isChUp) {
          claim();
          const next = zapRelative(id, 1);
          if (next) goLiveChannel(next);
          return;
        }
        if (isChDown) {
          claim();
          const next = zapRelative(id, -1);
          if (next) goLiveChannel(next);
          return;
        }
        if (digit) {
          claim();
          setNumBuffer((prev) => {
            const next = `${prev}${digit}`.slice(-4);
            clearTimeout(numTimer.current);
            numTimer.current = setTimeout(() => {
              const ch = zapByNumber(next);
              setNumBuffer('');
              if (ch) goLiveChannel(ch);
            }, 1200);
            return next;
          });
          return;
        }
        if (e.key === 'Enter' || code === 13 || code === 23) {
          claim();
          setControlsVisible(true);
          return;
        }
        return;
      }

      if (!isVodLike) return;

      const osdUp = controlsVisibleRef.current;
      const isLeft = e.key === 'MediaRewind' || e.key === 'ArrowLeft' || code === 412 || code === 37;
      const isRight = e.key === 'MediaFastForward' || e.key === 'ArrowRight' || code === 417 || code === 39;
      const isUp = e.key === 'ArrowUp' || code === 38;
      const isDown = e.key === 'ArrowDown' || code === 40;
      const isOk =
        e.key === 'Enter' ||
        e.key === 'MediaPlayPause' ||
        e.key === ' ' ||
        code === 13 ||
        code === 23 ||
        code === 179;
      const isMediaPlay = e.key === 'MediaPlay' || code === 415;
      const isMediaPause = e.key === 'MediaPause' || code === 19;

      // Holding the remote fires key-repeat — ignore those entirely for VOD.
      if (e.repeat && (isLeft || isRight || isUp || isDown || isOk || isMediaPlay || isMediaPause)) {
        claim();
        return;
      }

      // OSD closed: any transport key only reveals controls (Netflix/TV pattern).
      if (!osdUp && (isLeft || isRight || isUp || isDown || isOk || isMediaPlay || isMediaPause)) {
        claim();
        wakeOnly();
        return;
      }

      // Dedicated media keys still work when OSD is up.
      if (isMediaPlay) {
        claim();
        const v = videoRef.current;
        if (v?.paused) togglePlay();
        else bumpControls();
        return;
      }
      if (isMediaPause) {
        claim();
        const v = videoRef.current;
        if (v && !v.paused) togglePlay();
        else bumpControls();
        return;
      }

      // ← → only seek when the bar is already visible (+ cooldown).
      if (isLeft) {
        claim();
        seekBy(-seekJump);
        return;
      }
      if (isRight) {
        claim();
        seekBy(seekJump);
        return;
      }

      // ↑ ↓ never seek/pause — only keep the bar visible.
      if (isUp || isDown) {
        claim();
        bumpControls();
        return;
      }

      // OK / Enter / Space ALWAYS pause/play (never activate Atrás).
      if (isOk) {
        claim();
        togglePlay();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isVodLike, isLive, leaveOpen, navigate, seekJump, id]);

  // Auto-play next episode when a series finishes (pref).
  useEffect(() => {
    if (type !== 'series' || !seriesId) return undefined;
    const v = videoRef.current;
    if (!v) return undefined;
    const onEnded = () => {
      if (!getPrefs().autoplayNext) return;
      playNextEpisode().catch(() => {});
    };
    v.addEventListener('ended', onEnded);
    return () => v.removeEventListener('ended', onEnded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, seriesId, id, url, restart]);

  // Keep progress UI in sync for VOD-like streams.
  useEffect(() => {
    if (!isVodLike) return undefined;
    const v = videoRef.current;
    if (!v) return undefined;
    const sync = () => {
      setCurrentTime(v.currentTime || 0);
      setDuration(Number.isFinite(v.duration) ? v.duration : 0);
      setPaused(Boolean(v.paused));
    };
    v.addEventListener('timeupdate', sync);
    v.addEventListener('seeked', sync);
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    v.addEventListener('loadedmetadata', sync);
    sync();
    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('seeked', sync);
      v.removeEventListener('play', sync);
      v.removeEventListener('pause', sync);
      v.removeEventListener('loadedmetadata', sync);
    };
  }, [isVodLike, restart, started]);

  // Safety net on true unmount: destroy the controller (HLS/mpegts), force-abort
  // the request and wipe the video so the panel never keeps the stream "Online"
  // after leaving the screen. Runs before the [url] effect's own cleanup, so both
  // orders are idempotent (destroy() is safe to call once the ref is null).
  useEffect(
    () => () => {
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {}
        playerRef.current = null;
      }
      wipePlayback();
    },
    []
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) {
      setError(true);
      return undefined;
    }
    setMutedHint(false);
    startedRef.current = false;
    hlsClearedRef.current = false;

    // Strict serialization: only one live request load. Abort any previous
    // controller BEFORE starting this stream so the previous socket closes.
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch {}
    }
    const controller = new AbortController();
    abortRef.current = controller;

    const isExclusive = needsOriginHeaders(url);
    let player = null;
    const onPlaybackError = (err) => {
      // If this channel was playing via its HLS-only preference and even that
      // failed, forget the preference so a Retry re-tries mpegts (self-heal in
      // both directions — the memory must never lock a channel into a broken
      // route).
      if (preferHls) clearHlsOnlyChannel(channelKey);
      // Capture the MEDIA_ERR_* code (2 network / 3 decode / 4 src-not-supported)
      // so the error screen can explain a codec/container limitation.
      const code =
        err && typeof err.code === 'number'
          ? err.code
          : video && video.error && typeof video.error.code === 'number'
            ? video.error.code
            : null;
      // Fully release the media element + abort the request before surfacing
      // the error: no half-open connection against the panel. Also destroy the
      // controller so any native watchdog / HLS / mpegts worker is torn down and
      // the onError-caused DOM removal of <video> doesn't leave one running.
      if (player) {
        try { player.destroy(); } catch {}
        player = null;
        playerRef.current = null;
      }
      if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
      try {
        video.pause();
      } catch {}
      video.removeAttribute('src');
      video.src = '';
      try {
        video.load();
      } catch {}
      setErrorCode(code);
      setError(true);
    };
    // Live uses continuous MPEG-TS (mpegts.js + the proxy's shared .ts fan-out)
    // so the panel sees ONE endless connection per channel; VOD/series/catchup
    // and Exclusivos keep the HLS/native path. `isLive` diferencia la config del
    // motor: live usa baja latencia + mono-conexión estricta (mpegts con
    // enableStashBuffer:false y chasing activo; HLS con buffer mínimo), mientras
    // VOD usa buffer estable y arranque rápido.
    const isLivePlayback = type === 'live';
    const useTs = isLivePlayback && !isExclusive;
    player = useTs
      ? attachTs(video, url, {
          isLive: true,
          isExclusive,
          preferHls,
          onHlsFallback: () => {
            markHlsOnlyChannel(channelKey);
            // mpegts no pudo reproducir este canal. Si nunca llegó a arrancar
            // (empezando), reinicia el reproductor con un <video> NUEVO (key de
            // restart cambia) e irá DIRECTO a HLS — la vía que sí reproduce este
            // canal en navegadores donde mpegts falla. Si el canal YA estaba
            // reproduciendo y se trabó a mitad, no reinicia (evita bucle).
            if (!preferHls && !startedRef.current) {
              setError(false);
              setErrorCode(null);
              setStarted(false);
              startedRef.current = false;
              setRestart((x) => x + 1);
            }
          },
          onHlsFail: () => clearHlsOnlyChannel(channelKey),
          onError: onPlaybackError,
        })
      : attachHls(video, url, {
          isLive: isLivePlayback,
          startPosition,
          extraOrigin: isExclusive,
          isExclusive,
          alternateUrls,
          onError: onPlaybackError,
        });
    playerRef.current = player;

    // Once mpegts TS demonstrably reproduces this channel (currentTime advancing),
    // forget any "HLS-only" memory from an earlier session. That flag forces the
    // channel onto the HLS fallback, which for slow panels opens MANY upstream
    // connections (manifest reloads + per-segment fetches → the panel shows 3+
    // connections and the network tab floods). mpegts .ts is a SINGLE endless
    // connection, so once it works the channel must go back to TS on the next
    // zap. Only live+TS (non-Exclusivos) does this; VOD/HLS/Exclusivos keep
    // their memory untouched.
    const rememberTsWorks = () => {
      if (useTs && !hlsClearedRef.current) {
        hlsClearedRef.current = true;
        clearHlsOnlyChannel(channelKey);
      }
    };
    // Show a "Cargando…" overlay until the first real frames arrive, so slow
    // VOD that the player is retrying doesn't look frozen.
    const onPlaying = () => {
      startedRef.current = true;
      setStarted(true);
      rememberTsWorks();
    };
    video.addEventListener('playing', onPlaying);
    // Fast start: force play() as soon as the browser has decoded the first
    // frame (canplay / loadedmetadata), instead of waiting for several MB of
    // buffer before autoplay kicks in. Calling it again while already playing
    // is a harmless resolved promise.
    // An AbortError means this play() was superseded by a wipe/new-src during a
    // sequential candidate retry — NOT a real failure, so it must not tear the
    // player down. Any other rejection is treated like a playback error.
    const safePlay = () => {
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          if (err && err.name === 'AbortError') return;
          if (err && err.name === 'NotAllowedError') {
            // Autoplay with sound blocked (direct link to /player, strict
            // browser policy, or transient activation expired by the async
            // stream setup). Retry MUTED — autoplay muted is allowed
            // everywhere — and surface an unmute hint.
            video.muted = true;
            setMutedHint(true);
            const p2 = video.play();
            if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
            return;
          }
          onPlaybackError(err);
        });
      }
    };
    const onCanPlay = () => safePlay();
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('loadedmetadata', onCanPlay);
    safePlay();

    const wake = wakeLockController();
    wake.request();
    wakeRef.current = wake;

    const onTime = () => {
      // Clear the loading overlay as soon as the video is demonstrably
      // reproducing real content. Some TV browsers/webviews never fire the
      // `playing` event for MSE (hls.js/mpegts), leaving the spinner stuck over
      // an already-playing stream; an advancing currentTime is the reliable
      // signal. Guarded to >=1s so a still/black first frame doesn't clear it.
      if (video.currentTime >= 1) {
        startedRef.current = true;
        setStarted(true);
        // Also coalesced into rememberTsWorks (idempotent via hlsClearedRef) so
        // webviews that never fire `playing` still clear the HLS-only memory.
        rememberTsWorks();
      }
      if (video.duration > 0) {
        // Best-effort continue-watching: persist position periodically.
        updateContinueWatching({
          type,
          id,
          title: title || '',
          image: '',
          // Keep the RAW (pre-proxy) URL so Home's resume can rebuild it.
          url: url || '',
          position: Math.floor(video.currentTime || 0),
          duration: Math.floor(video.duration || 0),
        });
      }
    };
    video.addEventListener('timeupdate', onTime);

    const onStall = () => {
      if (type === 'live' && !video.paused && video.readyState < 3) {
        // DVR stall: nudge back toward the live edge.
        try {
          const end =
            video.seekable && video.seekable.length ? video.seekable.end(0) : video.currentTime;
          video.currentTime = Math.max(0, end - 2);
        } catch {}
      }
    };
    video.addEventListener('stalled', onStall);

    // For LIVE, pausing can release the panel slot. For VOD/series we must NOT
    // abort — otherwise Pause would kill the movie download.
    const onPause = () => {
      if (type !== 'live') return;
      if (abortRef.current) {
        try { abortRef.current.abort(); } catch {}
        abortRef.current = null;
      }
    };
    video.addEventListener('pause', onPause);

    return () => {
      video.dispatchEvent(new Event('timeupdate'));
      if (player) player.destroy();
      playerRef.current = null;
      if (wake) wake.release();
      wakeRef.current = null;
      setStarted(false);
      // Strict teardown on unmount/URL change: abort the request AND wipe the
      // element (removeAttribute('src') + src='' + load) so active downloads,
      // incl. byte-range (206) requests of VOD/movies/series, are aborted and no
      // connection stays live against the proxy/origin.
      if (abortRef.current) {
        try { abortRef.current.abort(); } catch {}
        abortRef.current = null;
      }
      startedRef.current = false;
      try { video.pause(); } catch {}
      video.removeAttribute('src');
      video.src = '';
      try { video.load(); } catch {}
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('stalled', onStall);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('loadedmetadata', onCanPlay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, restart]);

  // Auto-hide controls after inactivity. Any remote key reveals them again.
  useEffect(() => {
    const show = () => {
      setControlsVisible(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setControlsVisible(false), 4000);
    };
    show();
    const onKey = () => show();
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(hideTimer.current);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const formatClock = (secs) => {
    const s = Math.max(0, Math.floor(Number(secs) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  const seekToRatio = (ratio) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const next = Math.max(0, Math.min(duration, duration * ratio));
    try {
      v.currentTime = next;
    } catch {
      /* ignore */
    }
    setCurrentTime(next);
  };

  const togglePlayClick = (e) => {
    e?.stopPropagation?.();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      setPaused(false);
    } else {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
      setPaused(true);
    }
    setControlsVisible(true);
  };

  const seekByClick = (delta, e) => {
    e?.stopPropagation?.();
    const v = videoRef.current;
    if (!v) return;
    const now = Date.now();
    if (now - lastSeekAtRef.current < SEEK_COOLDOWN_MS) return;
    lastSeekAtRef.current = now;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const next = Math.max(0, Math.min(dur || Infinity, (v.currentTime || 0) + delta));
    try {
      v.currentTime = next;
    } catch {
      /* ignore */
    }
    setCurrentTime(next);
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 6000);
  };

  if (error || !url) {
    const formatIssue = errorCode === 4 || unsupportedContainer;
    const signalIssue = isLive && !formatIssue;
    return (
      <div className="player-screen">
        <div style={{ color: 'var(--text)', padding: '0 24px', textAlign: 'center', maxWidth: 640, margin: '0 auto' }}>
          {formatIssue
            ? t('player.formatError')
            : signalIssue
              ? t('player.signalError')
              : error
                ? t('player.error')
                : t('common.error')}
          <p className="hint" style={{ marginTop: 12 }}>
            {formatIssue ? t('player.formatHint') : signalIssue ? t('player.signalHint') : t('player.errorHint')}
          </p>
        </div>
        {error && (
          <button
            tabIndex={0}
            className="btn-ghost"
            style={{ position: 'absolute', bottom: 96, left: '50%', transform: 'translateX(-50%)' }}
            onClick={() => {
              setError(false);
              setErrorCode(null);
              setStarted(false);
              startedRef.current = false;
              setRestart((x) => x + 1);
            }}
          >
            {t('common.retry')}
          </button>
        )}
        <button
          tabIndex={0}
          className="btn-ghost"
          style={{ position: 'absolute', top: 24, left: 24 }}
          onClick={() => navigate(-1)}
        >
          ← {t('common.back')}
        </button>
      </div>
    );
  }

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      className="player-screen"
      onClick={() => {
        if (leaveOpen) return;
        setControlsVisible((v) => !v);
      }}
    >
      <video
        key={restart}
        ref={videoRef}
        autoPlay
        playsInline
        preload="none"
        onClick={(e) => e.stopPropagation()}
      />
      {!started && !error && (
        <div className="player-loading">
          <div className="spinner" />
          <span>{t('player.buffering')}</span>
          <button
            tabIndex={0}
            className="btn-ghost"
            onClick={() => {
              setStarted(false);
              startedRef.current = false;
              if (playerRef.current) playerRef.current.reloadUrl();
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {mutedHint && started && (
        <button
          tabIndex={0}
          className="unmute-hint"
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            v.muted = false;
            setMutedHint(false);
            const p = v.play();
            if (p && typeof p.catch === 'function') {
              p.catch(() => {
                v.muted = true;
                setMutedHint(true);
              });
            }
          }}
        >
          🔊 {t('player.unmute')}
        </button>
      )}

      {controlsVisible && !leaveOpen && (
        <div className="player-controls" onClick={(e) => e.stopPropagation()}>
          <div className="player-controls-top">
            <button
              tabIndex={0}
              className="back-btn"
              onClick={() => {
                if (isVodLike) setLeaveOpen(true);
                else navigate(-1);
              }}
            >
              ← {t('common.back')}
            </button>
            <span className="player-title">{title}</span>
            <button tabIndex={0} className="btn-ghost" onClick={() => togglePip(videoRef.current)}>
              PiP
            </button>
          </div>

          {isVodLike && (
            <>
              <div
                className="player-progress"
                role="slider"
                tabIndex={0}
                aria-valuemin={0}
                aria-valuemax={Math.floor(duration || 0)}
                aria-valuenow={Math.floor(currentTime || 0)}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
                  seekToRatio(ratio);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    seekByClick(-seekJump, e);
                  }
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    seekByClick(seekJump, e);
                  }
                }}
              >
                <div className="player-progress-bar">
                  <div className="player-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="player-time">
                  <span>{formatClock(currentTime)}</span>
                  <span>{formatClock(duration)}</span>
                </div>
              </div>

              <div className="player-transport">
                <button
                  tabIndex={0}
                  className="btn-ghost player-transport-btn"
                  onClick={(e) => seekByClick(-seekJump, e)}
                >
                  ⏪ -{seekJump}s
                </button>
                <button
                  ref={pauseBtnRef}
                  tabIndex={0}
                  data-player-pause="1"
                  className="btn-primary player-transport-btn"
                  onClick={togglePlayClick}
                >
                  {paused ? `▶ ${t('player.play')}` : `⏸ ${t('player.pause')}`}
                </button>
                <button
                  tabIndex={0}
                  className="btn-ghost player-transport-btn"
                  onClick={(e) => seekByClick(seekJump, e)}
                >
                  +{seekJump}s ⏩
                </button>
                {type === 'series' && seriesId ? (
                  <button
                    tabIndex={0}
                    className="btn-ghost player-transport-btn"
                    onClick={() => playNextEpisode().catch(() => {})}
                  >
                    {t('player.nextEpisode')} ⏭
                  </button>
                ) : null}
              </div>
              <p className="player-hint">{t('player.vodHint', { seek: seekJump })}</p>
            </>
          )}

          {isLive && (
            <p className="player-hint">{t('player.liveHint')}</p>
          )}
        </div>
      )}

      {(zapBanner || numBuffer) && (
        <div className="zap-banner" aria-live="polite">
          {numBuffer ? (
            <span className="zap-num">{numBuffer}_</span>
          ) : (
            <span>{zapBanner}</span>
          )}
        </div>
      )}

      {leaveOpen && (
        <div className="exit-overlay player-leave" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="exit-dialog">
            <h2>{t('player.leaveTitle')}</h2>
            <p>{t('player.leaveMessage')}</p>
            <div className="exit-actions">
              <button
                tabIndex={0}
                className="btn-primary"
                autoFocus
                onClick={() => setLeaveOpen(false)}
              >
                {t('player.leaveStay')}
              </button>
              <button
                tabIndex={0}
                className="btn-ghost"
                onClick={() => navigate(-1)}
              >
                {t('player.leaveConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
