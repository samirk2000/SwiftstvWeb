import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getLiveCategories, getLiveStreams, getShortEpg, liveCatchupUrl, liveStreamUrl } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { isCategoryLocked } from '../lib/parental.js';
import { isFavorite, toggleFavorite } from '../lib/session.js';
import { useFocusable } from '../components/Focusable.jsx';
import { formatEpgTime } from '../lib/time.js';

function ChannelRow({ channel, index, active, onPlay, onCatchup, fav, onToggleFav }) {
  const key = `live-ch-${channel.stream_id}`;
  const { ref, tabIndex } = useFocusable(key);

  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className={`channel ${active ? 'active' : ''}`}
      onClick={onPlay}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      <span className="channel-num">{index + 1}</span>
      <span className="channel-name">{channel.name}</span>
      <button
        className={fav ? 'fav-btn fa' : 'fav-btn'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav();
        }}
        title={fav ? t('common.unfavorite') : t('common.favorite')}
      >
        {fav ? '★' : '☆'}
      </button>
      {channel.tv_archive === '1' && (
        <button
          className="btn-ghost btn-xs"
          onClick={(e) => {
            e.stopPropagation();
            onCatchup();
          }}
        >
          {t('live.catchup')}
        </button>
      )}
      <span className="channel-now">
        {channel.epg_channel_id ? ` · ${channel.epg_channel_id}` : ''}
      </span>
    </div>
  );
}

// Date/time + programme picker for an archive-enabled channel. Reads the short
// EPG time-window and plays the selected programme via a catchup URL.
function CatchupPanel({ channel, server, onPlayCatchup, onClose }) {
  const [epg, setEpg] = useState(null);
  const [loadingEpg, setLoadingEpg] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingEpg(true);
    setEpg(null);
    getShortEpg(server, channel.stream_id, 72)
      .then((rows) => {
        if (cancelled) return;
        setEpg(rows || []);
        setLoadingEpg(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingEpg(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.stream_id]);

  const play = (prog) => {
    const startEpoch = Number(prog?.start) || 0;
    const endEpoch = Number(prog?.stop) || startEpoch + 3600;
    if (!startEpoch) return;
    const ts = channel.tv_archive_extension === 'ts';
    const url = liveCatchupUrl(server, channel.stream_id, { startEpoch, endEpoch, ts });
    onPlayCatchup(url, 0);
  };

  return (
    <div className="catchup-panel">
      <div className="catchup-head">
        <strong>{channel.name}</strong>
        <span className="hint">{t('live.catchupHint')}</span>
        <button className="btn-ghost btn-xs" onClick={onClose}>
          ✕ {t('common.back')}
        </button>
      </div>

      {loadingEpg ? (
        <div className="state small">
          <div className="spinner" /> {t('common.loading')}
        </div>
      ) : !epg || !epg.length ? (
        <div className="row-empty">{t('live.offAir')}</div>
      ) : (
        <div className="epg-list">
          {(epg || []).map((p) => (
            <button
              key={`${p.id || p.stream_id}-${p.start}`}
              className="epg-row"
              onClick={() => play(p)}
            >
              <span className="epg-time">{formatEpgTime(p.start)}</span>
              <span className="epg-title">{p.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LiveGuide() {
  const navigate = useNavigate();
  const { data: categories, server } = usePanelList(getLiveCategories);
  const [catId, setCatId] = usePersistedCategory('live');
  const catArgs = useMemo(() => (catId ? [catId] : []), [catId]);
  const { data: streams, loading, error } = usePanelList(getLiveStreams, catArgs);
  // Channel (if any) whose archive selector is open.
  const [catchupFor, setCatchupFor] = useState(null);
  // Favorites cache: key `type-id` -> bool, re-read when streams change.
  const [favTick, setFavTick] = useState(0);

  const isFav = (ch) =>
    ch && isFavorite('live', String(ch.stream_id));

  const toggleFavFor = (ch) => {
    toggleFavorite({
      type: 'live',
      id: String(ch.stream_id),
      title: ch.name || '',
      image: ch.stream_icon || '',
    });
    setFavTick((x) => x + 1);
  };

  // Parental gate: drop categories an active profile has locked.
  const visibleCats = useMemo(
    () => (categories || []).filter((c) => !isCategoryLocked(c.category_id)),
    [categories]
  );

  const playChannel = (ch) => {
    const url = liveStreamUrl(server, ch.stream_id);
    navigate(`/player?type=live&id=${ch.stream_id}&url=${encodeURIComponent(url)}`);
  };

  const playCatchup = (url, startPosition) => {
    navigate(`/player?type=catchup&start=${startPosition || 0}&url=${encodeURIComponent(url)}`);
  };

  return (
    <div>
      <div className="page-head">
        <h1>{t('live.title')}</h1>
      </div>

      {visibleCats && visibleCats.length > 0 && (
        <div className="cat-bar">
          <button
            className={`cat-chip ${catId === '' ? 'selected' : ''}`}
            onClick={() => setCatId('')}
          >
            {t('live.all')}
          </button>
          {visibleCats.map((cat) => (
            <button
              key={cat.category_id}
              className={`cat-chip ${String(catId) === String(cat.category_id) ? 'selected' : ''}`}
              onClick={() => setCatId(String(cat.category_id))}
            >
              {cat.category_name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : error || !streams?.length ? (
        <div className="state">
          {error ? t('common.error') : t('vod.noResults')}
        </div>
      ) : (
        <div className="channel-list">
          {streams.map((ch, i) => (
            <ChannelRow
              key={ch.stream_id}
              channel={ch}
              index={i}
              active={catchupFor?.stream_id === ch.stream_id}
              fav={isFav(ch)}
              onToggleFav={() => toggleFavFor(ch)}
              onPlay={() => playChannel(ch)}
              onCatchup={() => setCatchupFor(ch)}
            />
          ))}

          {catchupFor && (
            <CatchupPanel
              channel={catchupFor}
              server={server}
              onPlayCatchup={playCatchup}
              onClose={() => setCatchupFor(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
