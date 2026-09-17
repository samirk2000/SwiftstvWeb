import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { attachHls, attachTs, isUnsupportedContainer, mp4Variant, togglePip, wakeLockController, invalidatePlayback } from '../lib/player.js';
import { needsOriginHeaders } from '../lib/exclusivos.js';
import {
  updateContinueWatching,
  isHlsOnlyChannel,
  markHlsOnlyChannel,
  clearHlsOnlyChannel,
  getSession,
} from '../lib/session.js';
import { setFocused, getTvFocus, nearest } from '../components/Focusable.jsx';
import { getPrefs } from '../lib/prefs.js';
import {
  zapByNumber,
  setLastLiveChannel,
  getLiveZapList,
  findZapIndex,
  getLiveZapMeta,
  setLiveZapList,
  setLiveZapMeta,
  setLiveZapCatId,
} from '../lib/liveZap.js';
import { getSeriesInfo, seriesStreamUrl, getLiveStreams, liveStreamTsUrl } from '../lib/xtream.js';
import { isAdultCategory, isAdultContent } from '../lib/adult.js';
import { hasAdultPin } from '../lib/parental.js';
import AdultPinDialog from '../components/AdultPinDialog.jsx';
import {
  applyAudioTrack,
  applyTextTrack,
  collectTracks,
  cycleNextId,
  pickPreferredAudioId,
} from '../lib/tracks.js';
import {
  attachRemuxedAudio,
  cancelAllContainerAudioJobs,
  pickPreferredContainerAudioId,
  probeContainerAudioTracks,
} from '../lib/containerAudio.js';

/** PC/Mac (mouse + keyboard) vs TV remote — seek/click UX differs. */
function useDesktopPointer() {
  const [desktop, setDesktop] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  });
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const apply = () => setDesktop(mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else mq.addListener?.(apply);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', apply);
      else mq.removeListener?.(apply);
    };
  }, []);
  return desktop;
}

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
  // Live zap guide overlay: ↑↓ browse without changing the playing stream; OK tunes in.
  const [zapOpen, setZapOpen] = useState(false);
  const [zapIndex, setZapIndex] = useState(0);
  const [zapCatTick, setZapCatTick] = useState(0); // re-render overlay after category swap
  const [zapLoading, setZapLoading] = useState(false);
  const [adultPinOpen, setAdultPinOpen] = useState(false);
  const [pendingZapCat, setPendingZapCat] = useState(null);
  const [audioTracks, setAudioTracks] = useState([]);
  const [textTracks, setTextTracks] = useState([]);
  const [audioId, setAudioId] = useState(0);
  const [textId, setTextId] = useState(-1);
  const [trackBanner, setTrackBanner] = useState('');
  const audioPreferDoneRef = useRef(false);
  const containerAudioRef = useRef([]);
  const containerAudioIdRef = useRef(null);
  const remuxCtrlRef = useRef(null);
  const playUrlRef = useRef('');
  const resumeAtRef = useRef(null);
  const trackBannerTimer = useRef(null);
  // Netflix-style "next episode" card near the end of a series episode.
  const [nextUp, setNextUp] = useState(null); // { title, secs } | null
  const nextEpRef = useRef(null); // cached next episode payload
  const prevEpRef = useRef(null); // cached previous episode payload
  const nextUpDismissedRef = useRef(false);
  const nextUpPlayingRef = useRef(false);
  const nextUpRef = useRef(null);
  nextUpRef.current = nextUp;
  const zapOpenRef = useRef(false);
  const zapIndexRef = useRef(0);
  const zapLoadingRef = useRef(false);
  /** While true, visibility/pagehide must NOT kill playback (episode/channel swap). */
  const suppressSuspendRef = useRef(false);
  /** Bumped to cancel in-flight zap / episode navigates after leave or a newer swap. */
  const navGenRef = useRef(0);
  const hardStopRef = useRef(() => {});
  const leaveTimerRef = useRef(null);
  /** False after leave/hardStop until the next intentional attach (zap/episode/Stay/mount). */
  const allowAttachRef = useRef(true);
  zapOpenRef.current = zapOpen;
  zapIndexRef.current = zapIndex;
  zapLoadingRef.current = zapLoading;
  const numTimer = useRef(null);
  const prefs = getPrefs();
  const seekJump = Number(prefs.seekJump) || 30;
  const controlsVisibleRef = useRef(controlsVisible);
  controlsVisibleRef.current = controlsVisible;
  const lastSeekAtRef = useRef(0);
  const SEEK_COOLDOWN_MS = 650;
  const pauseBtnRef = useRef(null);
  const desktopPointer = useDesktopPointer();
  const desktopPointerRef = useRef(desktopPointer);
  desktopPointerRef.current = desktopPointer;

  const revealControls = useCallback(() => {
    if (leaveOpen || nextUpRef.current) return;
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    const hideMs = desktopPointerRef.current ? 5000 : 6000;
    hideTimer.current = setTimeout(() => setControlsVisible(false), hideMs);
  }, [leaveOpen]);

  const showTrackBanner = useCallback((msg) => {
    setTrackBanner(msg);
    if (trackBannerTimer.current) clearTimeout(trackBannerTimer.current);
    trackBannerTimer.current = window.setTimeout(() => setTrackBanner(''), 2800);
  }, []);

  const refreshTracks = useCallback(() => {
    const snap = collectTracks(playerRef.current, videoRef.current);
    const container = containerAudioRef.current;
    // Chromium/TV browsers often expose 0 native audioTracks on MKV/MP4 dual
    // titles — fall back to container probe (mediabunny) so Audio can cycle.
    let audio = snap.audio;
    let audioId = snap.audioId;
    let source = snap.source;
    if (container.length > 1 && audio.length < 2) {
      audio = container.map((t) => ({ id: t.id, label: t.label, lang: t.lang }));
      audioId =
        containerAudioIdRef.current != null
          ? containerAudioIdRef.current
          : pickPreferredContainerAudioId(container) ?? audio[0]?.id;
      source = 'container';
    }
    setAudioTracks(audio);
    setTextTracks(snap.text);
    setAudioId(audioId);
    setTextId(snap.textId);
    if (
      isVodLike &&
      !audioPreferDoneRef.current &&
      audio.length > 1 &&
      playerRef.current &&
      source !== 'container'
    ) {
      const pref = pickPreferredAudioId(audio);
      if (pref !== audioId) {
        applyAudioTrack(playerRef.current, videoRef.current, pref);
        setAudioId(pref);
      }
      audioPreferDoneRef.current = true;
    }
    return { audio, text: snap.text, audioId, textId: snap.textId, source };
  }, [isVodLike]);
  const refreshTracksRef = useRef(refreshTracks);
  refreshTracksRef.current = refreshTracks;

  const stopRemux = () => {
    const ctrl = remuxCtrlRef.current;
    remuxCtrlRef.current = null;
    if (ctrl) {
      try {
        const p = ctrl.destroy();
        if (p && typeof p.then === 'function') {
          p.catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }
    // Always cancel probe/remux UrlSource jobs — even if remux wasn't active,
    // a dual-audio probe can keep the previous episode "Online" on the panel.
    void cancelAllContainerAudioJobs();
  };

  const switchContainerAudio = async (trackId) => {
    const video = videoRef.current;
    const src = playUrlRef.current || video?.currentSrc || '';
    if (!video || !src) return false;
    const abs =
      remuxCtrlRef.current && typeof remuxCtrlRef.current.getAbsoluteTime === 'function'
        ? remuxCtrlRef.current.getAbsoluteTime()
        : video.currentTime || 0;
    showTrackBanner(t('player.switchingAudio'));
    suppressSuspendRef.current = true;
    allowAttachRef.current = false;
    stopRemux();
    if (playerRef.current && playerRef.current !== remuxCtrlRef.current) {
      try {
        playerRef.current.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    }
    invalidatePlayback();
    try {
      video.pause();
    } catch {
      /* ignore */
    }

    const preferred = pickPreferredContainerAudioId(containerAudioRef.current);
    // Default / preferred track → native demux (no remux tax).
    if (trackId === preferred) {
      resumeAtRef.current = abs;
      allowAttachRef.current = true;
      containerAudioIdRef.current = trackId;
      setRestart((x) => x + 1);
      window.setTimeout(() => {
        suppressSuspendRef.current = false;
      }, 1500);
      return true;
    }

    const ctrl = attachRemuxedAudio(video, src, trackId, {
      startPosition: abs,
      onReady: () => {
        setStarted(true);
        startedRef.current = true;
        setError(false);
      },
      onError: () => {
        showTrackBanner(t('player.audioSwitchFailed'));
        resumeAtRef.current = abs;
        allowAttachRef.current = true;
        stopRemux();
        setRestart((x) => x + 1);
      },
      onProgress: () => {},
    });
    remuxCtrlRef.current = ctrl;
    playerRef.current = ctrl;
    containerAudioIdRef.current = trackId;
    try {
      await ctrl.ready;
    } catch {
      /* onError handles */
    }
    window.setTimeout(() => {
      suppressSuspendRef.current = false;
    }, 1500);
    return true;
  };

  const cycleAudio = () => {
    const snap = refreshTracks();
    if (!snap.audio.length) {
      showTrackBanner(t('player.noAudioTracks'));
      return;
    }
    if (snap.audio.length < 2) {
      showTrackBanner(`${t('player.audio')}: ${snap.audio[0]?.label || '—'}`);
      return;
    }
    const next = cycleNextId(snap.audio, snap.audioId);
    const label = snap.audio.find((a) => a.id === next)?.label || String(next);
    if (snap.source === 'container' || containerAudioRef.current.length > 1) {
      void switchContainerAudio(next).then(() => {
        setAudioId(next);
        showTrackBanner(`${t('player.audio')}: ${label}`);
        revealControls();
      });
      return;
    }
    applyAudioTrack(playerRef.current, videoRef.current, next);
    setAudioId(next);
    showTrackBanner(`${t('player.audio')}: ${label}`);
    revealControls();
  };

  const cycleSubs = () => {
    const snap = refreshTracks();
    if (!snap.text.length) {
      showTrackBanner(t('player.noSubtitles'));
      return;
    }
    const next = cycleNextId(snap.text, snap.textId, { includeOff: true });
    applyTextTrack(playerRef.current, videoRef.current, next);
    setTextId(next);
    const label =
      next < 0
        ? t('player.subsOff')
        : snap.text.find((x) => x.id === next)?.label || String(next);
    showTrackBanner(`${t('player.subtitles')}: ${label}`);
    revealControls();
  };

  // Refresh track lists once playback is actually running (manifest parsed).
  useEffect(() => {
    if (!started || !isVodLike) return undefined;
    audioPreferDoneRef.current = false;
    refreshTracks();
    const timers = [800, 2000, 4500].map((ms) => window.setTimeout(() => refreshTracks(), ms));
    const onTracks = () => refreshTracks();
    const video = videoRef.current;
    try {
      video?.textTracks?.addEventListener?.('addtrack', onTracks);
      video?.audioTracks?.addEventListener?.('addtrack', onTracks);
    } catch {
      /* ignore */
    }
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      try {
        video?.textTracks?.removeEventListener?.('addtrack', onTracks);
        video?.audioTracks?.removeEventListener?.('addtrack', onTracks);
      } catch {
        /* ignore */
      }
    };
  }, [started, isVodLike, url, id, restart, refreshTracks]);

  useEffect(() => {
    audioPreferDoneRef.current = false;
    setAudioTracks([]);
    setTextTracks([]);
    setAudioId(0);
    setTextId(-1);
    setTrackBanner('');
    containerAudioRef.current = [];
    containerAudioIdRef.current = null;
    stopRemux();
  }, [url, id, type]);

  // Probe MKV/MP4 dual-audio tracks once playback has a real src (Chromium hides audioTracks).
  useEffect(() => {
    if (!started || !isVodLike) return undefined;
    let cancelled = false;
    const run = async () => {
      const src = videoRef.current?.currentSrc || playUrlRef.current || '';
      if (!src) return;
      const tracks = await probeContainerAudioTracks(src);
      if (cancelled || !tracks.length) return;
      containerAudioRef.current = tracks;
      if (containerAudioIdRef.current == null) {
        containerAudioIdRef.current = pickPreferredContainerAudioId(tracks);
      }
      refreshTracksRef.current?.();
    };
    const t1 = window.setTimeout(run, 600);
    const t2 = window.setTimeout(run, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [started, isVodLike, url, id, restart]);

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
  // Skip while the next-episode card owns the remote.
  useEffect(() => {
    if (!isVodLike || !controlsVisible || leaveOpen || nextUp) return undefined;
    const timer = window.setTimeout(() => {
      if (pauseBtnRef.current) setFocused(pauseBtnRef.current, { native: false });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [isVodLike, controlsVisible, leaveOpen, nextUp]);

  const EPISODE_GAP_MS = 400;
  const EPISODE_GAP_AFTER_REMUX_MS = 700;
  const CHANNEL_GAP_MS = 500;
  const LEAVE_GAP_MS = 400;

  // Wipe the media element and abort any in-flight request, releasing the
  // socket to the panel. Call on error, pause / unmount, or before a new stream.
  const wipePlayback = () => {
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch {
        /* ignore */
      }
      abortRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.removeAttribute('src');
      video.src = '';
      try {
        video.load();
      } catch {
        /* ignore */
      }
    }
  };

  /** Kill HLS/native + wipe BEFORE swapping episodes / leaving so the panel never sees overlapping streams. */
  const hardStopPlayback = () => {
    // Invalidate first so any delayed HLS fallback / native retry from this
    // attach is dead even before destroy() finishes clearing timers.
    invalidatePlayback();
    allowAttachRef.current = false;
    stopRemux();
    setZapOpen(false);
    zapOpenRef.current = false;
    setNumBuffer('');
    setZapBanner('');
    if (numTimer.current) clearTimeout(numTimer.current);
    if (playerRef.current) {
      try {
        playerRef.current.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    }
    wipePlayback();
    setStarted(false);
    startedRef.current = false;
    setError(false);
    setErrorCode(null);
    setPaused(false);
    setNextUp(null);
    setLeaveOpen(false);
  };
  hardStopRef.current = hardStopPlayback;

  const goLiveChannel = async (ch) => {
    if (!ch?.url) return;
    // Same channel — just close the overlay, don't reopen the stream.
    if (String(ch.id) === String(id) && String(ch.url) === String(url)) {
      setZapOpen(false);
      zapOpenRef.current = false;
      setNumBuffer('');
      return;
    }
    setZapOpen(false);
    zapOpenRef.current = false;
    setNumBuffer('');
    if (numTimer.current) clearTimeout(numTimer.current);
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setLastLiveChannel(ch.id);
    setZapBanner(ch.name || ch.id);
    window.setTimeout(() => setZapBanner(''), 2500);
    // Kill current stream FIRST. Cancel token so a Leave during the gap cannot
    // leave a later navigate() opening a ghost channel after the user exited.
    const gen = ++navGenRef.current;
    suppressSuspendRef.current = true;
    hardStopRef.current();
    await new Promise((r) => setTimeout(r, CHANNEL_GAP_MS));
    if (gen !== navGenRef.current) {
      suppressSuspendRef.current = false;
      return;
    }
    allowAttachRef.current = true;
    navigate(
      `/player?type=live&id=${encodeURIComponent(ch.id)}&url=${encodeURIComponent(ch.url)}&title=${encodeURIComponent(
        ch.name || ''
      )}`,
      { replace: true }
    );
    window.setTimeout(() => {
      if (gen === navGenRef.current) suppressSuspendRef.current = false;
    }, 1500);
  };

  const openZapAt = (idx) => {
    const list = getLiveZapList();
    if (!list.length) return;
    const safe = ((idx % list.length) + list.length) % list.length;
    setZapIndex(safe);
    zapIndexRef.current = safe;
    setZapOpen(true);
    zapOpenRef.current = true;
  };

  const moveZap = (delta) => {
    const list = getLiveZapList();
    if (!list.length) return;
    if (!zapOpenRef.current) {
      const cur = findZapIndex(id);
      openZapAt((cur < 0 ? 0 : cur) + delta);
      return;
    }
    // Always advance from the REF (not React state) so rapid CH± never
    // "bounces back" if a slow setState from an earlier press lands late.
    const next = (zapIndexRef.current + delta + list.length * 10) % list.length;
    zapIndexRef.current = next;
    setZapIndex(next);
  };

  const confirmZap = () => {
    if (zapLoadingRef.current) return;
    const list = getLiveZapList();
    const ch = list[zapIndexRef.current];
    if (ch) goLiveChannel(ch);
  };

  const loadZapCategory = async (nextCat, { adultSession } = {}) => {
    const saved = getSession();
    if (!saved?.baseUrl || !nextCat) return;
    setZapOpen(true);
    zapOpenRef.current = true;
    setZapLoading(true);
    zapLoadingRef.current = true;
    try {
      const srv = {
        baseUrl: saved.baseUrl,
        username: saved.username,
        password: saved.password,
      };
      const streams = await getLiveStreams(srv, nextCat.id || undefined);
      const allowAdult = Boolean(adultSession);
      const list = (Array.isArray(streams) ? streams : [])
        .filter((c) => {
          const adult = isAdultContent(c.name, '');
          // Category itself may be adult — allow only in adultSession.
          if (isAdultCategory(nextCat.name)) return allowAdult;
          return allowAdult ? true : !adult;
        })
        .map((c) => ({
          id: String(c.stream_id),
          name: c.name || '',
          url: liveStreamTsUrl(srv, c.stream_id),
        }));
      setLiveZapList(list);
      setLiveZapCatId(nextCat.id);
      const meta = getLiveZapMeta();
      setLiveZapMeta({ ...meta, catId: nextCat.id, adultSession: allowAdult });
      setZapIndex(0);
      zapIndexRef.current = 0;
      setZapCatTick((x) => x + 1);
    } catch {
      /* keep previous list */
    } finally {
      setZapLoading(false);
      zapLoadingRef.current = false;
    }
  };

  const shiftZapCategory = async (delta) => {
    if (zapLoadingRef.current) return;
    const meta = getLiveZapMeta();
    const cats = (meta.categories || []).filter((c) => {
      if (meta.adultSession) return true;
      // Keep Favoritos / Recientes / Todos; skip adult panel folders in overlay.
      if (c.id === '__favorites__' || c.id === '__recent__' || c.id === '') return true;
      return !isAdultCategory(c.name);
    });
    if (cats.length < 2) {
      if (!zapOpenRef.current) {
        const cur = findZapIndex(id);
        openZapAt(cur < 0 ? 0 : cur);
      }
      return;
    }
    let idx = cats.findIndex((c) => String(c.id) === String(meta.catId));
    if (idx < 0) idx = 0;
    const nextCat = cats[(idx + delta + cats.length * 10) % cats.length];
    if (!nextCat) return;

    if (isAdultCategory(nextCat.name) && !meta.adultSession) {
      setPendingZapCat(nextCat);
      setAdultPinOpen(true);
      return;
    }
    await loadZapCategory(nextCat, { adultSession: meta.adultSession || isAdultCategory(nextCat.name) });
  };

  const playNextEpisode = async () => {
    if (type !== 'series' || !seriesId) return false;
    if (nextUpPlayingRef.current) return true;

    const go = async (epId, season, epUrl, epTitle) => {
      nextUpPlayingRef.current = true;
      nextUpDismissedRef.current = true;
      // Close the current stream FIRST — switching episodes without this left
      // 2–3 panel connections alive and the next ep stuck on "Cargando…".
      // Suppress visibility/pagehide: wiping <video> on webOS/Tizen can fire
      // those events and hardStop would kill the NEXT episode mid-attach.
      // navGen cancels this navigate if the user Leaves during the gap.
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      const hadRemux = Boolean(remuxCtrlRef.current);
      const gen = ++navGenRef.current;
      suppressSuspendRef.current = true;
      try {
        // Kill remux/probe panel sockets before the navigate gap.
        stopRemux();
        hardStopRef.current();
        await cancelAllContainerAudioJobs();
        await new Promise((r) =>
          setTimeout(r, hadRemux ? EPISODE_GAP_AFTER_REMUX_MS : EPISODE_GAP_MS)
        );
        // Second wipe after the gap — delayed UrlSource retries must not revive.
        hardStopRef.current();
        await cancelAllContainerAudioJobs();
        if (gen !== navGenRef.current) {
          suppressSuspendRef.current = false;
          return false;
        }
        allowAttachRef.current = true;
        navigate(
          `/player?type=series&id=${encodeURIComponent(String(epId))}&seriesId=${encodeURIComponent(
            String(seriesId)
          )}&season=${encodeURIComponent(String(season))}&url=${encodeURIComponent(epUrl)}&title=${encodeURIComponent(
            epTitle
          )}`,
          { replace: true }
        );
      } finally {
        window.setTimeout(() => {
          if (gen === navGenRef.current) suppressSuspendRef.current = false;
          nextUpPlayingRef.current = false;
        }, 1200);
      }
      return true;
    };

    const cached = nextEpRef.current;
    if (cached?.url) {
      return go(cached.id, cached.season, cached.url, cached.title);
    }
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
    nextEpRef.current = {
      id: next.id,
      season,
      url: nextUrl,
      title: nextTitle,
    };
    return go(next.id, season, nextUrl, nextTitle);
  };

  const playPrevEpisode = async () => {
    if (type !== 'series' || !seriesId) return false;
    if (nextUpPlayingRef.current) return true;

    const go = async (epId, season, epUrl, epTitle) => {
      nextUpPlayingRef.current = true;
      nextUpDismissedRef.current = true;
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      const hadRemux = Boolean(remuxCtrlRef.current);
      const gen = ++navGenRef.current;
      suppressSuspendRef.current = true;
      try {
        stopRemux();
        hardStopRef.current();
        await cancelAllContainerAudioJobs();
        await new Promise((r) =>
          setTimeout(r, hadRemux ? EPISODE_GAP_AFTER_REMUX_MS : EPISODE_GAP_MS)
        );
        hardStopRef.current();
        await cancelAllContainerAudioJobs();
        if (gen !== navGenRef.current) {
          suppressSuspendRef.current = false;
          return false;
        }
        allowAttachRef.current = true;
        navigate(
          `/player?type=series&id=${encodeURIComponent(String(epId))}&seriesId=${encodeURIComponent(
            String(seriesId)
          )}&season=${encodeURIComponent(String(season))}&url=${encodeURIComponent(epUrl)}&title=${encodeURIComponent(
            epTitle
          )}`,
          { replace: true }
        );
      } finally {
        window.setTimeout(() => {
          if (gen === navGenRef.current) suppressSuspendRef.current = false;
          nextUpPlayingRef.current = false;
        }, 1200);
      }
      return true;
    };

    const cached = prevEpRef.current;
    if (cached?.url) {
      return go(cached.id, cached.season, cached.url, cached.title);
    }
    const saved = getSession();
    if (!saved) return false;
    const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
    const info = await getSeriesInfo(srv, seriesId);
    if (!info?.episodes) return false;
    const seasons = Object.keys(info.episodes || {}).sort((a, b) => Number(a) - Number(b));
    let season = seasonParam || seasons[0];
    let list = info.episodes[season] || [];
    let idx = list.findIndex((ep) => String(ep.id) === String(id));
    let prev = idx > 0 ? list[idx - 1] : null;
    if (!prev) {
      const sIdx = seasons.indexOf(String(season));
      if (sIdx > 0) {
        season = seasons[sIdx - 1];
        list = info.episodes[season] || [];
        prev = list.length ? list[list.length - 1] : null;
      }
    }
    if (!prev) return false;
    const container = prev.container_extension || info.container_extension || 'mp4';
    const prevUrl = seriesStreamUrl(srv, container, prev, season, seriesId);
    const epNum = prev.episode_num ? `E${prev.episode_num}` : '';
    const prevTitle =
      prev.title ||
      [info.info?.name, `T${season}`, epNum].filter(Boolean).join(' · ') ||
      String(prev.id);
    prevEpRef.current = {
      id: prev.id,
      season,
      url: prevUrl,
      title: prevTitle,
    };
    return go(prev.id, season, prevUrl, prevTitle);
  };

  // Prefetch prev/next episode so transport buttons are instant.
  useEffect(() => {
    nextUpDismissedRef.current = false;
    nextUpPlayingRef.current = false;
    nextEpRef.current = null;
    prevEpRef.current = null;
    setNextUp(null);
    if (type !== 'series' || !seriesId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const saved = getSession();
        if (!saved) return;
        const srv = { baseUrl: saved.baseUrl, username: saved.username, password: saved.password };
        const info = await getSeriesInfo(srv, seriesId);
        if (cancelled || !info?.episodes) return;
        const seasons = Object.keys(info.episodes || {}).sort((a, b) => Number(a) - Number(b));
        let season = seasonParam || seasons[0];
        let list = info.episodes[season] || [];
        let idx = list.findIndex((ep) => String(ep.id) === String(id));

        const pack = (ep, seasonKey) => {
          const container = ep.container_extension || info.container_extension || 'mp4';
          const epUrl = seriesStreamUrl(srv, container, ep, seasonKey, seriesId);
          const epNum = ep.episode_num ? `E${ep.episode_num}` : '';
          const epTitle =
            ep.title ||
            [info.info?.name, `T${seasonKey}`, epNum].filter(Boolean).join(' · ') ||
            String(ep.id);
          return { id: ep.id, season: seasonKey, url: epUrl, title: epTitle };
        };

        let next = idx >= 0 ? list[idx + 1] : null;
        let nextSeason = season;
        if (!next) {
          const sIdx = seasons.indexOf(String(season));
          if (sIdx >= 0 && sIdx < seasons.length - 1) {
            nextSeason = seasons[sIdx + 1];
            const nList = info.episodes[nextSeason] || [];
            next = nList[0];
          }
        }
        if (next && !cancelled) nextEpRef.current = pack(next, nextSeason);

        let prev = idx > 0 ? list[idx - 1] : null;
        let prevSeason = season;
        if (!prev) {
          const sIdx = seasons.indexOf(String(season));
          if (sIdx > 0) {
            prevSeason = seasons[sIdx - 1];
            const pList = info.episodes[prevSeason] || [];
            prev = pList.length ? pList[pList.length - 1] : null;
          }
        }
        if (prev && !cancelled) prevEpRef.current = pack(prev, prevSeason);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, seriesId, id, seasonParam, url]);

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

  /** Destroy stream first, brief gap for TCP close, then leave — never navigate while HLS/native still fetching.
   * Bumps navGen so an in-flight overlay zap / episode swap cannot reopen a stream after exit. */
  const leavePlayer = () => {
    const gen = ++navGenRef.current;
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    if (numTimer.current) clearTimeout(numTimer.current);
    // Leaving the player: never suppress suspend — any hide must keep the socket dead.
    suppressSuspendRef.current = false;
    stopRemux();
    hardStopRef.current();
    void cancelAllContainerAudioJobs();
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      if (gen !== navGenRef.current) return;
      // Second kill after the gap — delayed HLS fallback / native retry must not revive the socket.
      hardStopRef.current();
      void cancelAllContainerAudioJobs();
      if (type === 'live') {
        // Back to Live guide (same adult category stays via persisted cat + unlock).
        navigate('/live', { replace: true });
        return;
      }
      if (type === 'series' && seriesId) {
        navigate(`/series/${seriesId}`, { replace: true });
        return;
      }
      if (type === 'vod' && id) {
        navigate(`/vod/${id}`, { replace: true });
        return;
      }
      navigate(-1);
    }, LEAVE_GAP_MS);
  };
  const leavePlayerRef = useRef(leavePlayer);
  leavePlayerRef.current = leavePlayer;

  // 'p' toggles PiP. VOD is intentionally "slow": first D-pad/OK only opens the
  // bar; seek/pause need the bar visible. Ignores key-repeat so holding ←/→
  // does not rocket through the movie.
  useEffect(() => {
    const bumpControls = () => {
      setControlsVisible(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setControlsVisible(false), 6000);
    };

    const seekBy = (delta, opts = {}) => {
      const v = videoRef.current;
      if (!v || !isVodLike) return;
      const now = Date.now();
      const cooldown = opts.fast ? 120 : SEEK_COOLDOWN_MS;
      if (now - lastSeekAtRef.current < cooldown) return;
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
        // Kill the download immediately on Back — leaving the dialog open used
        // to keep the panel "Online" (and wipe-without-destroy on Confirm even
        // re-armed native retries → 2–3 ghost connections). Stay remounts.
        navGenRef.current += 1;
        hardStopRef.current();
        setLeaveOpen(true);
        setControlsVisible(true);
        return;
      }
      // Live: first Back closes zap overlay; second leaves cleanly to the guide.
      // If a zap navigate is in-flight (CHANNEL_GAP), still leave — don't only
      // close the overlay and let goLiveChannel reopen a ghost stream.
      if (zapOpenRef.current) {
        setZapOpen(false);
        zapOpenRef.current = false;
        setNumBuffer('');
        setZapBanner('');
        if (numTimer.current) clearTimeout(numTimer.current);
        return;
      }
      leavePlayerRef.current();
    };

    /** First press only wakes the OSD — no seek/pause yet. */
    const wakeOnly = () => {
      bumpControls();
      window.setTimeout(() => {
        const pauseBtn =
          document.querySelector('.player-transport [data-player-pause="1"]') ||
          document.querySelector('.player-transport-btn');
        if (pauseBtn) setFocused(pauseBtn, { native: false });
      }, 30);
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

      // Netflix next-episode card owns the remote while visible (trap).
      if (nextUpRef.current && type === 'series') {
        const isOk =
          e.key === 'Enter' ||
          e.key === 'MediaPlayPause' ||
          e.key === ' ' ||
          code === 13 ||
          code === 23 ||
          code === 179;
        const isLeft = e.key === 'ArrowLeft' || code === 37;
        const isRight = e.key === 'ArrowRight' || code === 39;
        const isUp = e.key === 'ArrowUp' || code === 38;
        const isDown = e.key === 'ArrowDown' || code === 40;
        if (isBack) {
          e.preventDefault();
          e.stopImmediatePropagation();
          nextUpDismissedRef.current = true;
          setNextUp(null);
          return;
        }
        if (isOk) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const el = getTvFocus();
          if (el?.closest?.('.next-up') && typeof el.click === 'function') {
            el.click();
          } else {
            playNextEpisode().catch(() => {});
          }
          return;
        }
        if (isLeft || isRight || isUp || isDown) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const btns = Array.from(document.querySelectorAll('.next-up button')).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (!btns.length) return;
          let active = getTvFocus();
          if (!active || !btns.includes(active)) {
            active = btns[0];
            setFocused(active, { native: false });
            return;
          }
          if (btns.length < 2) return;
          const dx = isLeft || isUp ? -1 : 1;
          const idx = btns.indexOf(active);
          const next = btns[(idx + dx + btns.length) % btns.length];
          if (next) setFocused(next, { native: false });
          return;
        }
        // Swallow any other transport key so the OSD underneath can't steal focus.
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

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

      // ---- LIVE: overlay zap (↑↓ canales, ←→ categoría, OK sintoniza) ----
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
        const isLeft = e.key === 'ArrowLeft' || code === 37;
        const isRight = e.key === 'ArrowRight' || code === 39;
        const digit = /^[0-9]$/.test(e.key || '') ? e.key : code >= 48 && code <= 57 ? String(code - 48) : '';

        if (e.repeat && (isChUp || isChDown || isLeft || isRight || digit)) {
          claim();
          return;
        }
        // ↑ = canal anterior (número más bajo), ↓ = siguiente — como control de TV.
        if (isChUp) {
          claim();
          moveZap(-1);
          return;
        }
        if (isChDown) {
          claim();
          moveZap(1);
          return;
        }
        if (isLeft) {
          claim();
          shiftZapCategory(-1);
          return;
        }
        if (isRight) {
          claim();
          shiftZapCategory(1);
          return;
        }
        if (digit) {
          claim();
          setNumBuffer((prev) => {
            const next = `${prev}${digit}`.slice(-4);
            clearTimeout(numTimer.current);
            const ch = zapByNumber(next);
            if (ch) {
              const idx = findZapIndex(ch.id);
              if (idx >= 0) openZapAt(idx);
            } else if (!zapOpenRef.current) {
              const cur = findZapIndex(id);
              openZapAt(cur < 0 ? 0 : cur);
            }
            numTimer.current = setTimeout(() => {
              const picked = zapByNumber(next);
              setNumBuffer('');
              if (picked) goLiveChannel(picked);
            }, 1400);
            return next;
          });
          return;
        }
        if (e.key === 'Enter' || code === 13 || code === 23) {
          claim();
          if (zapOpenRef.current) {
            confirmZap();
          } else {
            setControlsVisible(true);
          }
          return;
        }
        return;
      }

      if (!isVodLike) return;

      const osdUp = controlsVisibleRef.current;
      const isSeekLeft = e.key === 'MediaRewind' || code === 412;
      const isSeekRight = e.key === 'MediaFastForward' || code === 417;
      const isLeft = e.key === 'ArrowLeft' || code === 37;
      const isRight = e.key === 'ArrowRight' || code === 39;
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

      // Holding the remote fires key-repeat — ignore those entirely for VOD,
      // except while scrubbing the progress bar (power-user fast seek).
      const onProgress =
        getTvFocus()?.classList?.contains('player-progress') ||
        document.activeElement?.classList?.contains('player-progress');
      if (
        e.repeat &&
        !(onProgress && (isLeft || isRight || isSeekLeft || isSeekRight)) &&
        (isLeft || isRight || isUp || isDown || isOk || isMediaPlay || isMediaPause || isSeekLeft || isSeekRight)
      ) {
        claim();
        return;
      }

      // OSD closed:
      //  - TV remote: first press only reveals controls (Netflix pattern).
      //  - PC/Mac: ←→ seek and Space/OK play-pause immediately, and show the bar.
      if (
        !osdUp &&
        (isLeft || isRight || isUp || isDown || isOk || isMediaPlay || isMediaPause || isSeekLeft || isSeekRight)
      ) {
        claim();
        if (desktopPointerRef.current && isVodLike) {
          bumpControls();
          if (isLeft || isSeekLeft) {
            seekBy(-seekJump, { fast: true });
            return;
          }
          if (isRight || isSeekRight) {
            seekBy(seekJump, { fast: true });
            return;
          }
          if (isOk || isMediaPlay || isMediaPause) {
            if (isMediaPlay) {
              const v = videoRef.current;
              if (v?.paused) togglePlay();
            } else if (isMediaPause) {
              const v = videoRef.current;
              if (v && !v.paused) togglePlay();
            } else {
              togglePlay();
            }
            return;
          }
          // ↑↓ on desktop still just reveal / focus transport
          wakeOnly();
          return;
        }
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
      // Hardware FF/Rewind still seek; D-pad arrows navigate the OSD buttons.
      if (isSeekLeft) {
        claim();
        seekBy(-seekJump);
        return;
      }
      if (isSeekRight) {
        claim();
        seekBy(seekJump);
        return;
      }

      // OSD open: arrows move across progress bar + transport. On the bar,
      // ←→ scrub (repeat allowed). Elsewhere they only move focus.
      if (isLeft || isRight || isUp || isDown) {
        claim();
        const progressEl = document.querySelector('.player-progress');
        const transportRoot = document.querySelector('.player-transport');
        const transportBtns = transportRoot
          ? Array.from(transportRoot.querySelectorAll('button.player-transport-btn:not([disabled])')).filter(
              (el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              },
            )
          : [];
        const list = [progressEl, ...transportBtns].filter(Boolean);
        let active = getTvFocus();
        if (!active || !list.includes(active)) {
          active = transportBtns.find((el) => el.dataset?.playerPause === '1') || transportBtns[0] || progressEl;
          if (active) setFocused(active, { native: false });
        }

        const scrubbing = active?.classList?.contains('player-progress');
        if (scrubbing && (isLeft || isRight)) {
          seekBy(isLeft ? -seekJump : seekJump, { fast: true });
          bumpControls();
          return;
        }

        if (active && list.length > 1) {
          const dx = isLeft ? -1 : isRight ? 1 : 0;
          const dy = isUp ? -1 : isDown ? 1 : 0;
          const target = nearest(
            dx,
            dy,
            active.getBoundingClientRect(),
            list.filter((el) => el !== active),
          );
          if (target) setFocused(target, { native: false });
        }
        bumpControls();
        return;
      }

      // OK activates the focused control (Pause / ±30s / progreso no-op / episodio).
      if (isOk) {
        claim();
        const el = getTvFocus();
        if (el?.classList?.contains('player-progress')) {
          bumpControls();
          return;
        }
        if (el && el.closest?.('.player-transport') && typeof el.click === 'function') {
          el.click();
        } else {
          const pauseBtn =
            document.querySelector('.player-transport [data-player-pause="1"]') ||
            document.querySelector('.player-transport-btn');
          if (pauseBtn) {
            setFocused(pauseBtn, { native: false });
            pauseBtn.click();
          } else {
            togglePlay();
          }
        }
        bumpControls();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isVodLike, isLive, leaveOpen, navigate, seekJump, id]);

  // Auto-play next episode when a series finishes (pref) + Netflix end-card.
  useEffect(() => {
    if (type !== 'series' || !seriesId) return undefined;
    const v = videoRef.current;
    if (!v) return undefined;

    const NEXT_UP_WINDOW = 18; // seconds before end to show the card

    const onTime = () => {
      if (nextUpDismissedRef.current || leaveOpen) {
        setNextUp((p) => (p ? null : p));
        return;
      }
      const ep = nextEpRef.current;
      if (!ep) return;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const tNow = v.currentTime || 0;
      if (dur < 45) return;
      const rem = dur - tNow;
      if (rem <= 0.35) {
        if (getPrefs().autoplayNext !== false) {
          playNextEpisode().catch(() => {});
        }
        return;
      }
      if (rem <= NEXT_UP_WINDOW) {
        const secs = Math.max(1, Math.ceil(rem));
        setNextUp((prev) =>
          prev && prev.title === ep.title && prev.secs === secs
            ? prev
            : { title: ep.title, secs }
        );
      } else {
        setNextUp(null);
      }
    };

    const onEnded = () => {
      if (nextUpDismissedRef.current) return;
      if (getPrefs().autoplayNext === false) return;
      playNextEpisode().catch(() => {});
    };

    v.addEventListener('timeupdate', onTime);
    v.addEventListener('seeked', onTime);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('seeked', onTime);
      v.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, seriesId, id, url, restart, leaveOpen]);

  // Park focus on "Ver ahora" when the next-episode card appears — and keep
  // re-asserting briefly so the Pause-button autofocus can't win the race.
  const nextUpVisible = Boolean(nextUp);
  useEffect(() => {
    if (!nextUpVisible || leaveOpen) return undefined;
    setControlsVisible(false);
    const focusNow = () => {
      const preferred =
        document.querySelector('.next-up .btn-primary') ||
        document.querySelector('.next-up button');
      if (preferred) setFocused(preferred, { native: false });
    };
    const timers = [30, 120, 350, 700].map((ms) => window.setTimeout(focusNow, ms));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [nextUpVisible, leaveOpen]);

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
      navGenRef.current += 1;
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      invalidatePlayback();
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

  // No background streams: if the TV/browser hides this page (app switch, sleep,
  // another tab), kill playback immediately. Resume only if we are still on the
  // player when focus returns — browsing Live/Home must never keep sockets open.
  // Skip while swapping episodes/channels: wiping <video> often fires pagehide
  // on webOS/Tizen and used to kill the next episode right after attach.
  useEffect(() => {
    const suspendedRef = { current: false };
    const onVis = () => {
      if (suppressSuspendRef.current) return;
      if (document.hidden || document.visibilityState === 'hidden') {
        hardStopRef.current();
        suspendedRef.current = true;
        return;
      }
      if (suspendedRef.current) {
        suspendedRef.current = false;
        allowAttachRef.current = true;
        setRestart((x) => x + 1);
      }
    };
    const onPageHide = () => {
      if (suppressSuspendRef.current) return;
      hardStopRef.current();
      suspendedRef.current = true;
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('freeze', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('freeze', onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) {
      setError(true);
      return undefined;
    }
    if (!allowAttachRef.current) {
      return undefined;
    }
    setMutedHint(false);
    setError(false);
    setErrorCode(null);
    startedRef.current = false;
    hlsClearedRef.current = false;

    // Belt-and-suspenders: never attach on top of a leftover controller.
    if (playerRef.current) {
      try {
        playerRef.current.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    }

    // Strict serialization: only one live request load. Abort any previous
    // controller BEFORE starting this stream so the previous socket closes.
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch {
        /* ignore */
      }
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
            // Remember HLS-only for the NEXT zap. Do NOT remount the player
            // here — attachTs.fallbackToHls already starts a single HLS after
            // tearing down mpegts. setRestart used to open a 2nd HLS while the
            // delayed fallback still ran → panel showed 2–3 connections.
            markHlsOnlyChannel(channelKey);
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
          onTracksUpdate: () => refreshTracksRef.current?.(),
        });
    playerRef.current = player;

    // Remember the proxied media URL for dual-audio remux (currentSrc after attach).
    window.setTimeout(() => {
      if (video?.currentSrc) playUrlRef.current = video.currentSrc;
    }, 400);

    // Resume after switching back from remuxed alternate audio → preferred track.
    if (resumeAtRef.current != null && isVodLike) {
      const resumeAt = resumeAtRef.current;
      resumeAtRef.current = null;
      const seekResume = () => {
        try {
          if (Number.isFinite(resumeAt) && resumeAt > 0) video.currentTime = resumeAt;
        } catch {
          /* ignore */
        }
      };
      video.addEventListener('loadedmetadata', seekResume, { once: true });
      video.addEventListener('playing', seekResume, { once: true });
    }

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
      if (video.duration > 0 && type !== 'live' && type !== 'catchup') {
        // Best-effort continue-watching: persist position periodically.
        // Live channels go to Recientes inside Live TV (never Home).
        updateContinueWatching({
          type,
          id,
          title: title || '',
          image: '',
          // Keep the RAW (pre-proxy) URL so Home's resume can rebuild it.
          url: url || '',
          position: Math.floor(video.currentTime || 0),
          duration: Math.floor(video.duration || 0),
          seriesId: seriesId || '',
          season: seasonParam || '',
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
  }, [url, restart, id, type]);

  // If a new episode never leaves "Cargando…", surface Retry instead of spinning forever
  // (usually the panel still had the previous connection open).
  useEffect(() => {
    if (!url || error || started || !isVodLike) return undefined;
    const t = window.setTimeout(() => {
      if (!startedRef.current) {
        setError(true);
        setErrorCode(2);
      }
    }, 35000);
    return () => window.clearTimeout(t);
  }, [url, id, restart, error, started, isVodLike]);

  // Auto-hide controls after inactivity. Keys / mouse reveal them again.
  useEffect(() => {
    const show = () => {
      if (nextUpRef.current || leaveOpen) return;
      setControlsVisible(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(
        () => setControlsVisible(false),
        desktopPointerRef.current ? 5000 : 4000,
      );
    };
    show();
    const onKey = () => show();
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(hideTimer.current);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [leaveOpen]);

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
    if (!v || !isVodLike) return;
    const dur = Number.isFinite(v.duration) ? v.duration : duration;
    if (!dur) return;
    const next = Math.max(0, Math.min(dur, dur * Math.max(0, Math.min(1, ratio))));
    try {
      v.currentTime = next;
    } catch {
      /* ignore */
    }
    setCurrentTime(next);
    revealControls();
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
    revealControls();
  };

  const seekByClick = (delta, e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    const v = videoRef.current;
    if (!v || !isVodLike) return;
    // Mouse clicks skip the remote seek cooldown so ± buttons always respond.
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const next = Math.max(0, Math.min(dur || Infinity, (v.currentTime || 0) + delta));
    try {
      v.currentTime = next;
    } catch {
      /* ignore */
    }
    setCurrentTime(next);
    lastSeekAtRef.current = Date.now();
    revealControls();
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
              allowAttachRef.current = true;
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
          onClick={() => {
            leavePlayer();
          }}
        >
          ← {t('common.back')}
        </button>
      </div>
    );
  }

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      className={`player-screen${desktopPointer ? ' player-screen--desktop' : ''}`}
      onClick={() => {
        if (leaveOpen || nextUp) return;
        // TV: click toggles OSD. Desktop uses mousemove / video click instead.
        if (!desktopPointer) setControlsVisible((v) => !v);
      }}
      onMouseMove={() => {
        if (desktopPointer) revealControls();
      }}
      onMouseEnter={() => {
        if (desktopPointer) revealControls();
      }}
    >
      <video
        key={`${type}-${id}-${restart}`}
        ref={videoRef}
        autoPlay
        playsInline
        preload="none"
        onClick={(e) => {
          e.stopPropagation();
          if (leaveOpen || nextUp) return;
          revealControls();
          if (isVodLike) togglePlayClick(e);
        }}
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

      {controlsVisible && !leaveOpen && !nextUp && (
        <div className="player-controls" onClick={(e) => e.stopPropagation()}>
          <div className="player-controls-top">
            <button
              tabIndex={0}
              className="back-btn"
              onClick={() => {
                if (isVodLike) {
                  navGenRef.current += 1;
                  hardStopRef.current();
                  setLeaveOpen(true);
                } else leavePlayer();
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
                data-focusable="true"
                aria-valuemin={0}
                aria-valuemax={Math.floor(duration || 0)}
                aria-valuenow={Math.floor(currentTime || 0)}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
                  seekToRatio(ratio);
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
                {type === 'series' && seriesId ? (
                  <button
                    type="button"
                    tabIndex={0}
                    className="btn-ghost player-transport-btn"
                    onClick={() => playPrevEpisode().catch(() => {})}
                  >
                    ⏮ {t('player.prevEpisode')}
                  </button>
                ) : null}
                <button
                  type="button"
                  tabIndex={0}
                  className="btn-ghost player-transport-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => seekByClick(-seekJump, e)}
                >
                  ⏪ -{seekJump}s
                </button>
                <button
                  ref={pauseBtnRef}
                  type="button"
                  tabIndex={0}
                  data-player-pause="1"
                  className="btn-primary player-transport-btn"
                  onClick={togglePlayClick}
                >
                  {paused ? `▶ ${t('player.play')}` : `⏸ ${t('player.pause')}`}
                </button>
                <button
                  type="button"
                  tabIndex={0}
                  className="btn-ghost player-transport-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => seekByClick(seekJump, e)}
                >
                  +{seekJump}s ⏩
                </button>
                {type === 'series' && seriesId ? (
                  <button
                    type="button"
                    tabIndex={0}
                    className="btn-ghost player-transport-btn"
                    onClick={() => playNextEpisode().catch(() => {})}
                  >
                    {t('player.nextEpisode')} ⏭
                  </button>
                ) : null}
                <button
                  type="button"
                  tabIndex={0}
                  className="btn-ghost player-transport-btn"
                  onClick={cycleAudio}
                >
                  🔊 {t('player.audio')}
                  {audioTracks.length > 1
                    ? ` (${audioTracks.find((a) => a.id === audioId)?.label || ''})`
                    : ''}
                </button>
                <button
                  type="button"
                  tabIndex={0}
                  className="btn-ghost player-transport-btn"
                  onClick={cycleSubs}
                >
                  CC {t('player.subtitles')}
                  {textTracks.length
                    ? ` (${
                        textId < 0
                          ? t('player.subsOff')
                          : textTracks.find((x) => x.id === textId)?.label || ''
                      })`
                    : ''}
                </button>
              </div>
              <p className="player-hint">
                {desktopPointer
                  ? t('player.vodHintDesktop', seekJump)
                  : t('player.vodHint', seekJump)}
              </p>
            </>
          )}

          {isLive && (
            <p className="player-hint">{t('player.liveHint')}</p>
          )}
        </div>
      )}

      {(zapBanner || numBuffer || trackBanner) && !zapOpen && (
        <div className="zap-banner" aria-live="polite">
          {numBuffer ? (
            <span className="zap-num">{numBuffer}_</span>
          ) : trackBanner ? (
            <span>{trackBanner}</span>
          ) : (
            <span>{zapBanner}</span>
          )}
        </div>
      )}

      {nextUp && type === 'series' && !leaveOpen && (
        <div
          className="next-up"
          role="dialog"
          aria-modal="true"
          aria-live="polite"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="next-up-label">{t('player.nextUpTitle')}</div>
          <div className="next-up-title">{nextUp.title}</div>
          <div className="next-up-count">{t('player.nextUpIn', nextUp.secs)}</div>
          <div className="next-up-actions">
            <button
              tabIndex={0}
              className="btn-primary"
              data-focusable="true"
              onClick={() => playNextEpisode().catch(() => {})}
            >
              {t('player.nextUpNow')}
            </button>
            <button
              tabIndex={0}
              className="btn-ghost"
              data-focusable="true"
              onClick={() => {
                nextUpDismissedRef.current = true;
                setNextUp(null);
              }}
            >
              {t('player.nextUpCancel')}
            </button>
          </div>
        </div>
      )}

      {isLive && zapOpen && (() => {
        const list = getLiveZapList();
        const meta = getLiveZapMeta();
        const catName =
          meta.categories.find((c) => String(c.id) === String(meta.catId))?.name ||
          t('player.zapGuide');
        const win = 7;
        const half = Math.floor(win / 2);
        let start = list.length ? Math.max(0, zapIndex - half) : 0;
        let end = Math.min(list.length, start + win);
        start = Math.max(0, end - win);
        const slice = list.slice(start, end);
        return (
          <div className="zap-guide" role="listbox" aria-label={t('player.zapGuide')} data-zap-tick={zapCatTick}>
            <div className="zap-guide-head">
              <span className="zap-guide-cat">← {catName} →</span>
              {numBuffer ? <span className="zap-num">{numBuffer}_</span> : null}
            </div>
            {zapLoading ? (
              <div className="zap-guide-loading">{t('common.loading')}</div>
            ) : (
              <ul className="zap-guide-list">
                {slice.map((ch, i) => {
                  const abs = start + i;
                  const active = abs === zapIndex;
                  const playing = String(ch.id) === String(id);
                  return (
                    <li
                      key={ch.id}
                      className={`zap-guide-row ${active ? 'is-active' : ''} ${playing ? 'is-playing' : ''}`}
                      role="option"
                      aria-selected={active}
                    >
                      <span className="zap-guide-num">{abs + 1}</span>
                      <span className="zap-guide-name">{ch.name || ch.id}</span>
                      {playing ? <span className="zap-guide-now">{t('player.zapPlaying')}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="zap-guide-hint">{t('player.zapHint')}</p>
          </div>
        );
      })()}

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
                onClick={() => {
                  setLeaveOpen(false);
                  // Stream was killed when the dialog opened — remount to resume.
                  allowAttachRef.current = true;
                  setRestart((x) => x + 1);
                }}
              >
                {t('player.leaveStay')}
              </button>
              <button
                tabIndex={0}
                className="btn-ghost"
                onClick={() => leavePlayer()}
              >
                {t('player.leaveConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <AdultPinDialog
        open={adultPinOpen}
        creating={!hasAdultPin()}
        onDismiss={() => {
          setAdultPinOpen(false);
          setPendingZapCat(null);
        }}
        onUnlocked={() => {
          const cat = pendingZapCat;
          setAdultPinOpen(false);
          setPendingZapCat(null);
          if (cat) loadZapCategory(cat, { adultSession: true });
        }}
      />
    </div>
  );
}
