import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { attachHls, togglePip, wakeLockController } from '../lib/player.js';
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
  const [controlsVisible, setControlsVisible] = useState(true);
  const [error, setError] = useState(false);
  const [started, setStarted] = useState(false);

  // 'p' toggles PiP; handled screen-local.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'p' || e.key === 'P') togglePip(videoRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) {
      setError(true);
      return undefined;
    }

    const isExclusive = needsOriginHeaders(url);
    const onPlaybackError = () => {
      // Fully release the media element before surfacing the error: stop
      // playback and drop the source so the <video> doesn't keep the panel's
      // session "Online" after a failed/aborted load.
      try {
        video.pause();
      } catch {}
      video.removeAttribute('src');
      try {
        video.load();
      } catch {}
      setError(true);
    };
    const player = attachHls(video, url, {
      startPosition,
      extraOrigin: isExclusive,
      isExclusive,
      onError: onPlaybackError,
    });
    playerRef.current = player;

    // Show a "Cargando…" overlay until the first real frames arrive, so slow
    // VOD that the player is retrying doesn't look frozen.
    const onPlaying = () => setStarted(true);
    video.addEventListener('playing', onPlaying);
    // A 'stalled'/'waiting' after we already started is normal buffering.
    video.play()
      .then(() => {})
      .catch(() => setError(true));

    const wake = wakeLockController();
    wake.request();
    wakeRef.current = wake;

    const onTime = () => {
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

    return () => {
      video.dispatchEvent(new Event('timeupdate'));
      if (player) player.destroy();
      playerRef.current = null;
      if (wake) wake.release();
      wakeRef.current = null;
      setStarted(false);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('stalled', onStall);
      video.removeEventListener('playing', onPlaying);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

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
    return (
      <div className="player-screen">
        <div style={{ color: 'var(--text)' }}>
          {error ? t('player.error') : t('common.error')}
        </div>
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
