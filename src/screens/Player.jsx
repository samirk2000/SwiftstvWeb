import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { attachHls, attachTs, isUnsupportedContainer, mp4Variant, togglePip, wakeLockController } from '../lib/player.js';
import { needsOriginHeaders } from '../lib/exclusivos.js';
import { updateContinueWatching } from '../lib/session.js';

export default function Player() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);

  const url = params.get('url');
  const type = params.get('type') || 'live';
  const id = params.get('id') || '';
  const title = params.get('title') || (type === 'live' ? t('live.title') : '');
  const startPosition = Number(params.get('start') || 0) || 0;

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
  // Bumped by the manual Retry button so the [url] effect re-runs and rebuilds
  // the player from scratch (destroying any previous controller first).
  const [restart, setRestart] = useState(0);

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

  // 'p' toggles PiP; handled screen-local.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'p' || e.key === 'P') togglePip(videoRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

    // Show a "Cargando…" overlay until the first real frames arrive, so slow
    // VOD that the player is retrying doesn't look frozen.
    const onPlaying = () => setStarted(true);
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
      if (video.currentTime >= 1) setStarted(true);
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

    // Draining the buffer / pausing releases the connection: abort any
    // outstanding request load so the panel sees the socket close.
    const onPause = () => {
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

  // Auto-hide controls after inactivity.
  useEffect(() => {
    const show = () => {
      setControlsVisible(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
    };
    show();
    return () => clearTimeout(hideTimer.current);
  }, []);

  if (error || !url) {
    const formatIssue = errorCode === 4 || unsupportedContainer;
    return (
      <div className="player-screen">
        <div style={{ color: 'var(--text)', padding: '0 24px', textAlign: 'center' }}>
          {formatIssue ? t('player.formatError') : error ? t('player.error') : t('common.error')}
        </div>
        {error && (
          <button
            className="btn-ghost"
            style={{ position: 'absolute', bottom: 96, left: '50%', transform: 'translateX(-50%)' }}
            onClick={() => {
              // Manual retry only — never an automatic loop. Reset the error and
              // bump `restart` so the [url] effect re-runs, destroying any old
              // controller and rebuilding the player from scratch.
              setError(false);
              setErrorCode(null);
              setStarted(false);
              setRestart((x) => x + 1);
            }}
          >
            {t('common.retry')}
          </button>
        )}
        <button
          className="btn-ghost"
          style={{ position: 'absolute', top: 24, left: 24 }}
          onClick={() => navigate(-1)}
        >
          ← {t('common.back')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="player-screen"
      onClick={() => {
        setControlsVisible((v) => !v);
        setTimeout(() => {}, 0);
      }}
    >
      <video
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
            className="btn-ghost"
            onClick={() => {
              setStarted(false);
              if (playerRef.current) playerRef.current.reloadUrl();
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {controlsVisible && (
        <div className="player-controls">
          <button className="back-btn" onClick={() => navigate(-1)}>
            ← {t('common.back')}
          </button>
          <span className="player-title">{title}</span>
          <button className="btn-ghost" onClick={() => togglePip(videoRef.current)}>
            PiP
          </button>
        </div>
      )}
    </div>
  );
}
