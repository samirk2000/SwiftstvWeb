import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getLiveCategories, getLiveStreams, getShortEpg, liveCatchupUrl, liveStreamTsUrl } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { usePreferFirstCategory } from '../hooks/usePreferFirstCategory.js';
import { useWindowedList } from '../hooks/useWindowedList.js';
import { isCategoryLocked, hasAdultPin, needsAdultGate, unlockAdultBrowse, clearAdultBrowseUnlock, isAdultBrowseUnlocked } from '../lib/parental.js';
import { isAdultContent, isAdultCategory } from '../lib/adult.js';
import {
  isFavorite,
  toggleFavorite,
  getFavoritesByType,
  getRecentLive,
  pushRecentLive,
} from '../lib/session.js';
import { useFocusable, FocusScope, setFocused, getTvFocus } from '../components/Focusable.jsx';
import AdultPinDialog from '../components/AdultPinDialog.jsx';
import { formatEpgTime, currentProgramme, epochAtLocal, shortDayLabel } from '../lib/time.js';
import { setLiveZapList, setLiveZapMeta, setLastLiveChannel } from '../lib/liveZap.js';
import { matchesSearch } from '../lib/searchText.js';

// Days offered by the catch-up manual selector (today + N days back).
const CATCHUP_DAYS = 7;
const CATCHUP_HOURS = Array.from({ length: 24 }, (_, i) => i);
const PAGE = 60;
const CAT_FAVORITES = '__favorites__';
const CAT_RECENT = '__recent__';

function isLocalLiveCat(id) {
  return id === CAT_FAVORITES || id === CAT_RECENT;
}

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
        type="button"
        tabIndex={0}
        data-tv-secondary="true"
        className={`channel-action-btn channel-fav-btn ${fav ? 'is-fav' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav();
        }}
      >
        {fav ? t('live.favOn') : t('live.favAdd')}
      </button>
      {channel.tv_archive === '1' && (
        <button
          type="button"
          tabIndex={0}
          data-tv-secondary="true"
          className="channel-action-btn"
          onClick={(e) => {
            e.stopPropagation();
            onCatchup();
          }}
        >
          {t('live.catchup')}
        </button>
      )}
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
    <FocusScope trap autoFocus className="catchup-panel">
      <div className="catchup-head">
        <strong>{channel.name}</strong>
        <span className="hint">{t('live.catchupHint')}</span>
        <button tabIndex={0} className="btn-ghost btn-xs" onClick={onClose}>
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
        <button tabIndex={0} className="btn-primary btn-xs" onClick={playManual}>
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
              tabIndex={0}
              className="epg-row"
              onClick={() => play(p)}
            >
              <span className="epg-time">{formatEpgTime(p.start)}</span>
              <span className="epg-title">{p.title}</span>
            </button>
          ))}
        </div>
      )}
    </FocusScope>
  );
}

export default function LiveGuide() {
  const navigate = useNavigate();
  const { data: categories, server } = usePanelList(getLiveCategories);
  const [catId, setCatId] = usePersistedCategory('live');
  const [query, setQuery] = useState('');
  const [favTick, setFavTick] = useState(0);
  const searchActive = Boolean(query.trim());
  const localCat = isLocalLiveCat(catId);
  const ready = searchActive || catId !== null;
  const effectiveCatId = searchActive || localCat ? '' : catId || '';
  const catArgs = useMemo(
    () => (effectiveCatId ? [effectiveCatId] : []),
    [effectiveCatId]
  );
  const { data: streams, loading, error } = usePanelList(getLiveStreams, catArgs, {
    enabled: ready && !localCat,
  });
  // Channel (if any) whose archive selector is open.
  const [catchupFor, setCatchupFor] = useState(null);
  // Channel currently focused (drives the now+next EPG strip).
  const [focused, setFocusedCh] = useState(null);
  // Adult PIN gate: pending category id or pending channel play.
  const [pinPending, setPinPending] = useState(null); // { kind: 'cat'|'play', id, cat?, ch? }

  const isFav = (ch) => ch && isFavorite('live', String(ch.stream_id));

  const catNameById = useMemo(() => {
    const m = new Map();
    for (const c of categories || []) m.set(String(c.category_id), c.category_name);
    return m;
  }, [categories]);

  const toggleFavFor = (ch) => {
    const categoryName = catNameById.get(String(ch.category_id)) || ch.category_name || '';
    toggleFavorite({
      type: 'live',
      id: String(ch.stream_id),
      title: ch.name || '',
      image: ch.stream_icon || '',
      categoryId: ch.category_id,
      categoryName,
    });
    setFavTick((x) => x + 1);
  };

  // Parental gate: drop categories an active profile has locked.
  const visibleCats = useMemo(
    () => (categories || []).filter((c) => !isCategoryLocked(c.category_id)),
    [categories]
  );
  // Prefer a non-adult category on first visit (adult always needs PIN first).
  const preferCats = useMemo(
    () => (visibleCats || []).filter((c) => !isAdultCategory(c.category_name)),
    [visibleCats]
  );
  usePreferFirstCategory(
    catId,
    setCatId,
    preferCats.length ? preferCats : visibleCats,
    searchActive
  );

  const localStreams = useMemo(() => {
    if (catId === CAT_FAVORITES) {
      // Never surface adult in Favoritos (Home-safe + overlay-safe).
      return getFavoritesByType('live')
        .filter((f) => !isAdultContent(f.title, f.categoryName))
        .map((f) => ({
          stream_id: f.id,
          name: f.title,
          stream_icon: f.image,
          category_id: f.categoryId || CAT_FAVORITES,
          category_name: f.categoryName || '',
        }));
    }
    if (catId === CAT_RECENT) {
      return getRecentLive().map((r) => ({
        stream_id: r.id,
        name: r.title,
        stream_icon: r.image,
        category_id: r.categoryId || CAT_RECENT,
        category_name: r.categoryName || '',
      }));
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catId, favTick]);

  const filtered = useMemo(() => {
    const base = localCat ? localStreams || [] : streams || [];
    if (!query.trim()) return base;
    return base.filter((ch) => {
      if (matchesSearch(ch.name, query)) return true;
      const catName = catNameById.get(String(ch.category_id)) || ch.category_name || '';
      return matchesSearch(catName, query);
    });
  }, [streams, localStreams, localCat, query, catNameById]);

  const { visible, hasMore, loadMore, remaining } = useWindowedList(filtered, PAGE);

  // Track category-focus settle timer so rapid cat changes don't keep stealing focus.
  const catFocusTimerRef = useRef(null);

  /** Focus the first channel only when the list has no channel focused yet.
   * Never yank the ring back while the user is already zapping down the list. */
  const focusFirstChannelIfNeeded = () => {
    const list = document.querySelector('.channel-list');
    if (!list) return false;
    const cur = getTvFocus();
    if (cur && list.contains(cur) && cur.classList.contains('channel')) {
      return true; // user already navigating — leave them alone
    }
    const first = list.querySelector('.channel');
    if (!first) return false;
    setFocused(first, { native: false });
    return true;
  };

  // After category change / load: seed focus on the first channel once (short retries).
  // Do NOT keep re-focusing for 1.4s+ — that snaps the marker back during fast zap.
  useEffect(() => {
    if (!ready || (!localCat && loading) || !visible.length) return undefined;
    let cancelled = false;
    const run = () => {
      if (!cancelled) focusFirstChannelIfNeeded();
    };
    run();
    const timers = [40, 150, 350].map((ms) => window.setTimeout(run, ms));
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
    // Only re-seed when the category identity changes — not on every filtered.length bump
    // (that used to restart steal-timers mid-zap when the panel finished loading).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loading, catId, localCat, visible[0]?.stream_id]);

  const selectCategory = (id) => {
    const cat = (visibleCats || []).find((c) => String(c.category_id) === String(id));
    if (cat && isAdultCategory(cat.category_name)) {
      // Already unlocked this adult folder → stay in; don't re-ask every channel.
      if (isAdultBrowseUnlocked(id)) {
        applyCategory(id);
        return;
      }
      setPinPending({ kind: 'cat', id: String(id), cat });
      return;
    }
    // Left adult section → next adult open needs PIN again.
    clearAdultBrowseUnlock();
    applyCategory(id);
  };

  const applyCategory = (id) => {
    setQuery('');
    setCatId(id);
    if (catFocusTimerRef.current) {
      window.clearInterval(catFocusTimerRef.current);
      catFocusTimerRef.current = null;
    }
    let tries = 0;
    catFocusTimerRef.current = window.setInterval(() => {
      tries += 1;
      // Stop as soon as ANY channel in the list has focus (or list empty too long).
      if (focusFirstChannelIfNeeded() || tries > 20) {
        window.clearInterval(catFocusTimerRef.current);
        catFocusTimerRef.current = null;
      }
    }, 80);
  };

  const doPlayChannel = (ch) => {
    const categoryName =
      catNameById.get(String(ch.category_id)) || ch.category_name || '';
    const adult = isAdultContent(ch.name, categoryName);
    if (!adult) {
      pushRecentLive({
        id: ch.stream_id,
        title: ch.name || '',
        image: ch.stream_icon || '',
        categoryId: ch.category_id,
        categoryName,
      });
      setFavTick((x) => x + 1);
    }
    // Zap overlay: never list adult channels unless THIS play is already adult
    // (user passed PIN). Keeps porn out of the overlay on normal TV.
    const zapSource = (filtered || []).filter((c) => {
      const cn = catNameById.get(String(c.category_id)) || c.category_name || '';
      const isAd = isAdultContent(c.name, cn);
      return adult ? isAd : !isAd;
    });
    const list = zapSource.map((c) => ({
      id: String(c.stream_id),
      name: c.name || '',
      url: liveStreamTsUrl(server, c.stream_id),
      categoryName: catNameById.get(String(c.category_id)) || c.category_name || '',
    }));
    setLiveZapList(list);
    const zapCats = [
      { id: CAT_FAVORITES, name: t('live.favorites') },
      { id: CAT_RECENT, name: t('live.recent') },
      { id: '', name: t('live.all') },
      ...(visibleCats || [])
        .filter((c) => adult || !isAdultCategory(c.category_name))
        .map((c) => ({
          id: String(c.category_id),
          name: c.category_name || String(c.category_id),
        })),
    ];
    setLiveZapMeta({
      catId: localCat ? catId : effectiveCatId || catId || '',
      categories: zapCats,
      adultSession: adult,
    });
    setLastLiveChannel(String(ch.stream_id));
    const url = liveStreamTsUrl(server, ch.stream_id);
    // Do NOT replace — keep Live under the player so exit returns to the same
    // adult category instead of popping to Home.
    navigate(
      `/player?type=live&id=${ch.stream_id}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(
        ch.name || ''
      )}`
    );
  };

  const playChannel = (ch) => {
    const categoryName =
      catNameById.get(String(ch.category_id)) || ch.category_name || '';
    const adult = needsAdultGate(ch.name, categoryName);
    // PIN only when opening the adult category — not on every channel inside it.
    if (
      adult &&
      !isAdultBrowseUnlocked(ch.category_id) &&
      !isAdultBrowseUnlocked(catId)
    ) {
      setPinPending({ kind: 'play', ch });
      return;
    }
    doPlayChannel(ch);
  };

  const onPinUnlocked = () => {
    const pending = pinPending;
    setPinPending(null);
    if (!pending) return;
    if (pending.kind === 'cat') {
      unlockAdultBrowse(pending.id);
      applyCategory(pending.id);
      return;
    }
    if (pending.kind === 'play' && pending.ch) {
      const cid = pending.ch.category_id;
      if (cid != null && cid !== '') unlockAdultBrowse(cid);
      else if (catId) unlockAdultBrowse(catId);
      doPlayChannel(pending.ch);
    }
  };

  const playCatchup = (url, startPosition) => {
    navigate(`/player?type=catchup&start=${startPosition || 0}&url=${encodeURIComponent(url)}`);
  };

  const emptyMsg =
    catId === CAT_FAVORITES
      ? t('live.noFavorites')
      : catId === CAT_RECENT
        ? t('live.noRecent')
        : t('vod.noResults');

  const showLoading = ready && !localCat && loading;

  return (
    <div>
      <AdultPinDialog
        open={Boolean(pinPending)}
        creating={!hasAdultPin()}
        onDismiss={() => setPinPending(null)}
        onUnlocked={onPinUnlocked}
      />
      <div className="page-head">
        <h1>{t('live.title')}</h1>
      </div>

      <input
        tabIndex={0}
        className="search-box"
        placeholder={t('live.search')}
        value={query}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          if (v.trim() && catId) setCatId('');
        }}
      />

      <div className="cat-bar">
        <FocusChip
          id="live-cat-fav"
          label={t('live.favorites')}
          selected={!searchActive && catId === CAT_FAVORITES}
          onClick={() => selectCategory(CAT_FAVORITES)}
        />
        <FocusChip
          id="live-cat-recent"
          label={t('live.recent')}
          selected={!searchActive && catId === CAT_RECENT}
          onClick={() => selectCategory(CAT_RECENT)}
        />
        <FocusChip
          id="live-cat-all"
          label={t('live.all')}
          selected={!searchActive && catId === ''}
          onClick={() => selectCategory('')}
        />
        {(visibleCats || []).map((cat) => (
          <FocusChip
            key={cat.category_id}
            id={`live-cat-${cat.category_id}`}
            label={cat.category_name}
            selected={!searchActive && String(catId) === String(cat.category_id)}
            onClick={() => selectCategory(String(cat.category_id))}
          />
        ))}
      </div>

      {focused && !catchupFor && (
        <NowNextPanel channel={focused} server={server} />
      )}

      {showLoading ? (
        <div className="state">
          <div className="spinner" />
          {t('common.loading')}
        </div>
      ) : error || !filtered?.length ? (
        <div className="state">{error ? t('common.error') : emptyMsg}</div>
      ) : (
        <div className="channel-list">
          {visible.map((ch, i) => (
            <ChannelRow
              key={ch.stream_id}
              channel={ch}
              index={i}
              active={catchupFor?.stream_id === ch.stream_id}
              fav={isFav(ch)}
              onFocus={() => setFocusedCh(ch)}
              onToggleFav={() => toggleFavFor(ch)}
              onPlay={() => playChannel(ch)}
              onCatchup={() => setCatchupFor(ch)}
            />
          ))}

          {hasMore ? (
            <div className="load-more-wrap">
              <button tabIndex={0} className="btn-primary load-more-btn" onClick={loadMore}>
                {t('common.loadMore', remaining)}
              </button>
            </div>
          ) : null}

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
