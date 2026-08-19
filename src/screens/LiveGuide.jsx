import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getLiveCategories, getLiveStreams, getShortEpg, liveCatchupUrl, liveStreamTsUrl } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { isCategoryLocked } from '../lib/parental.js';
import { isFavorite, toggleFavorite } from '../lib/session.js';
import { useFocusable } from '../components/Focusable.jsx';
import { formatEpgTime, currentProgramme, epochAtLocal, shortDayLabel } from '../lib/time.js';

// Days offered by the catch-up manual selector (today + N days back).
const CATCHUP_DAYS = 7;
const CATCHUP_HOURS = Array.from({ length: 24 }, (_, i) => i);

// A D-pad focusable chip (selected state + click). Registered in the global
// focus ring so a remote can reach it like the other TV-first controls.
function FocusChip({ id, label, selected, onClick }) {
  const { ref, tabIndex } = useFocusable(id);
  return (
    <button
      ref={ref}
      tabIndex={tabIndex}
      className={`cat-chip ${selected ? 'selected' : ''}`}
      onClick={onClick}
      onMouseEnter={() => ref.current && ref.current.focus()}
    >
      {label}
    </button>
  );
}

function ChannelRow({ channel, index, active, onPlay, onCatchup, fav, onToggleFav, onFocus }) {
  const key = `live-ch-${channel.stream_id}`;
  const { ref, tabIndex } = useFocusable(key);

  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      className={`channel ${active ? 'active' : ''}`}
      onClick={onPlay}
      onFocus={() => onFocus(channel)}
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

// "Now + next" strip for the focused channel: shows the currently-airing
// programme and the next few upcoming ones from get_short_epg.
function NowNextPanel({ channel, server }) {
  const [epg, setEpg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setEpg(null);
    getShortEpg(server, channel.stream_id, 8)
      .then((rows) => {
        if (!cancelled) setEpg(rows || []);
      })
      .catch(() => {
        if (!cancelled) setEpg([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.stream_id, server?.baseUrl]);

  const now = currentProgramme(epg);
  const upcoming = (epg || [])
    .filter((e) => Number(e.start || 0) > Date.now() / 1000)
    .sort((a, b) => Number(a.start) - Number(b.start))
    .slice(0, 3);

  return (
    <div className="nownext">
      <div className="nownext-title">
        <strong>{channel.name}</strong>
      </div>
      <div className="nownext-now">
        <span className="badge now-badge">{t('live.now')}</span>
        <span className="nownext-prog">
          {now ? `${formatEpgTime(now.start)} · ${now.title}` : t('live.offAir')}
        </span>
      </div>
      {upcoming.length > 0 && (
        <div className="nownext-next">
          <span className="badge">{t('live.next')}</span>
          <span className="nownext-prog">
            {upcoming.map((u) => `${formatEpgTime(u.start)} ${u.title}`).join('  ·  ')}
          </span>
        </div>
      )}
    </div>
  );
}

function dayLabel(d) {
  if (d === 0) return `${t('live.today')} ${shortDayLabel(0)}`;
  if (d === 1) return `${t('live.yesterday')} ${shortDayLabel(1)}`;
  return shortDayLabel(d);
}

// Date/time + programme picker for an archive-enabled channel. Reads the short
// EPG time-window and plays the selected programme via a catchup URL, or lets
// the user pick an arbitrary day/hour to build a window manually.
function CatchupPanel({ channel, server, onPlayCatchup, onClose }) {
  const [epg, setEpg] = useState(null);
  const [loadingEpg, setLoadingEpg] = useState(true);
  const [dayOffset, setDayOffset] = useState(0);
  const [hour, setHour] = useState(new Date().getHours());

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

  const playManual = () => {
    const startEpoch = epochAtLocal(dayOffset, hour);
    const endEpoch = startEpoch + 2 * 3600;
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

      <div className="catchup-manual">
        <div className="catchup-manual-row">
          <span className="catchup-label">{t('live.catchupDay')}</span>
          <div className="chip-row">
            {Array.from({ length: CATCHUP_DAYS }, (_, d) => (
              <FocusChip
                key={`day-${d}`}
                id={`catchup-day-${channel.stream_id}-${d}`}
                selected={dayOffset === d}
                onClick={() => setDayOffset(d)}
                label={dayLabel(d)}
              />
            ))}
          </div>
        </div>
        <div className="catchup-manual-row">
          <span className="catchup-label">{t('live.catchupTime')}</span>
          <div className="chip-row">
            {CATCHUP_HOURS.map((h) => (
              <FocusChip
                key={`hour-${h}`}
                id={`catchup-hour-${channel.stream_id}-${h}`}
                selected={hour === h}
                onClick={() => setHour(h)}
                label={`${String(h).padStart(2, '0')}:00`}
              />
            ))}
          </div>
        </div>
        <button className="btn-primary btn-xs" onClick={playManual}>
          ▶ {t('live.catchupAt')}
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
  // Channel currently focused (drives the now+next EPG strip).
  const [focused, setFocused] = useState(null);
  // Favorites cache: key `type-id` -> bool, re-read when streams change.
  const [favTick, setFavTick] = useState(0);
  const [query, setQuery] = useState('');

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

  // category_id -> name lookup so search can also match the category label.
  const catNameById = useMemo(() => {
    const m = new Map();
    for (const c of categories || []) m.set(String(c.category_id), c.category_name);
    return m;
  }, [categories]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !streams) return streams || [];
    return (streams || []).filter((ch) => {
      if (String(ch.name || '').toLowerCase().includes(q)) return true;
      const catName = catNameById.get(String(ch.category_id)) || '';
      return String(catName).toLowerCase().includes(q);
    });
  }, [streams, query, catNameById]);

  const playChannel = (ch) => {
    // Continuous MPEG-TS live: /live/U/P/id.ts → the proxy keeps ONE shared
    // upstream connection per channel and the player decodes it with mpegts.js.
    const url = liveStreamTsUrl(server, ch.stream_id);
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

      <input
        className="search-box"
        placeholder={t('live.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

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

      {focused && !catchupFor && (
        <NowNextPanel channel={focused} server={server} />
      )}

      {loading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : error || !filtered?.length ? (
        <div className="state">
          {error ? t('common.error') : t('vod.noResults')}
        </div>
      ) : (
        <div className="channel-list">
          {filtered.map((ch, i) => (
            <ChannelRow
              key={ch.stream_id}
              channel={ch}
              index={i}
              active={catchupFor?.stream_id === ch.stream_id}
              fav={isFav(ch)}
              onFocus={() => setFocused(ch)}
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
