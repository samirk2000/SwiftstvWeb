import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n.js';
import { getLiveCategories, getLiveStreams, getShortEpg, liveCatchupUrl, liveStreamTsUrl } from '../lib/xtream.js';
import { usePanelList } from '../hooks/usePanelList.js';
import { usePersistedCategory } from '../hooks/usePersistedCategory.js';
import { isCategoryLocked } from '../lib/parental.js';
import { isAdultCategory, isAdultContent } from '../lib/adult.js';
import { getFavoritesByType, pushRecentLive } from '../lib/session.js';
import { useFocusable, setFocused } from '../components/Focusable.jsx';
import { formatEpgTime } from '../lib/time.js';
import { setLiveZapList, setLiveZapMeta, setLastLiveChannel } from '../lib/liveZap.js';

// Cable-style guide: channels as rows, a horizontal timeline in 30-min slots.
// Light on purpose for low-end TVs: the whole grid is ONE focusable element
// that moves an internal cursor, only ~7 rows are in the DOM, and the EPG of a
// channel is fetched only when its row comes near the screen.

const SLOT = 30 * 60; // seconds
const PX_PER_MIN = 6; // 30 min = 180 px
const CHAN_COL = 230; // px, channel name column
const VISIBLE_ROWS = 7;
const PREFETCH_ROWS = 4; // extra rows above/below whose EPG we load
const EPG_TTL_MS = 10 * 60 * 1000;
const EPG_CONCURRENCY = 3;
const PAST_LIMIT = 2 * 3600; // how far back ← can scroll (catch-up)
const CAT_FAVORITES = '__favorites__';

const epgCache = new Map(); // stream_id -> { at, rows }
const epgInflight = new Map();
const epgQueue = [];
let epgActive = 0;

function pumpEpg() {
  while (epgActive < EPG_CONCURRENCY && epgQueue.length) {
    const job = epgQueue.shift();
    epgActive += 1;
    getShortEpg(job.server, job.id, 12)
      .then((rows) => epgCache.set(job.id, { at: Date.now(), rows: rows || [] }))
      .catch(() => epgCache.set(job.id, { at: Date.now(), rows: [] }))
      .finally(() => {
        epgActive -= 1;
        epgInflight.delete(job.id);
        job.done();
        pumpEpg();
      });
  }
}

function requestEpg(server, id, done) {
  const hit = epgCache.get(id);
  if (hit && Date.now() - hit.at < EPG_TTL_MS) return;
  if (epgInflight.has(id)) return;
  epgInflight.set(id, true);
  epgQueue.push({ server, id, done });
  pumpEpg();
}

const slotFloor = (sec) => Math.floor(sec / SLOT) * SLOT;
const nowSec = () => Math.floor(Date.now() / 1000);

function GridChip({ id, label, selected, onClick }) {
  const { ref, tabIndex } = useFocusable(id);
  return (
    <button ref={ref} tabIndex={tabIndex} className={`cat-chip ${selected ? 'selected' : ''}`} onClick={onClick}>
      {label}
    </button>
  );
}

function progAt(progs, time) {
  return progs.find((p) => p.start <= time && p.stop > time) || null;
}

export default function EpgGrid() {
  const navigate = useNavigate();
  const { data: categories, server } = usePanelList(getLiveCategories);
  const [catId, setCatId] = usePersistedCategory('live');
  const effectiveCat = catId === CAT_FAVORITES ? '' : catId || '';
  const catArgs = useMemo(() => (effectiveCat ? [effectiveCat] : []), [effectiveCat]);
  const loadList = useCallback((srv, cat) => getLiveStreams(srv, cat, { throwOnError: true, timeoutMs: 60000 }), []);
  const { data: streams, loading, error, reload } = usePanelList(loadList, catArgs, {
    enabled: catId !== null && catId !== CAT_FAVORITES,
  });

  const visibleCats = useMemo(
    () => (categories || []).filter((c) => !isCategoryLocked(c.category_id) && !isAdultCategory(c.category_name)),
    [categories],
  );
  // Opened directly (no category chosen yet): start on the first category.
  useEffect(() => {
    if (catId === null && visibleCats.length) setCatId(String(visibleCats[0].category_id));
  }, [catId, visibleCats, setCatId]);
  const catName = useMemo(() => {
    const m = new Map();
    for (const c of categories || []) m.set(String(c.category_id), c.category_name || '');
    return m;
  }, [categories]);

  const channels = useMemo(() => {
    const base =
      catId === CAT_FAVORITES
        ? getFavoritesByType('live').map((f) => ({
            stream_id: f.id,
            name: f.title,
            stream_icon: f.image,
            category_id: f.categoryId,
            category_name: f.categoryName || '',
          }))
        : streams || [];
    return base.filter((c) => !isAdultContent(c.name, catName.get(String(c.category_id)) || c.category_name || ''));
  }, [catId, streams, catName]);

  // Cursor: row + a time inside the selected programme.
  const [row, setRow] = useState(0);
  const [cursor, setCursor] = useState(() => nowSec());
  const [winStart, setWinStart] = useState(() => slotFloor(nowSec()) - SLOT);
  const [now, setNow] = useState(() => nowSec());
  const [epgTick, setEpgTick] = useState(0);
  const [trackW, setTrackW] = useState(900);
  const gridRef = useRef(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(nowSec()), 30000);
    return () => window.clearInterval(id);
  }, []);

  // Reset the cursor when the channel list changes (category switch).
  useEffect(() => {
    setRow(0);
    setCursor(nowSec());
    setWinStart(slotFloor(nowSec()) - SLOT);
  }, [catId]);

  useEffect(() => {
    const measure = () => {
      const w = gridRef.current?.clientWidth || 1100;
      setTrackW(Math.max(360, w - CHAN_COL));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [channels.length]);

  const winSecs = Math.floor((trackW / PX_PER_MIN) * 60);
  const winEnd = winStart + winSecs;
  const top = Math.max(0, Math.min(row - 3, channels.length - VISIBLE_ROWS));
  const shown = channels.slice(top, top + VISIBLE_ROWS);

  // Lazy EPG: only the rows on screen (plus a few around them).
  useEffect(() => {
    if (!server || !channels.length) return;
    const from = Math.max(0, top - PREFETCH_ROWS);
    const to = Math.min(channels.length, top + VISIBLE_ROWS + PREFETCH_ROWS);
    // Visible rows first, then the prefetch margin.
    const order = [];
    for (let i = top; i < Math.min(channels.length, top + VISIBLE_ROWS); i += 1) order.push(i);
    for (let i = from; i < to; i += 1) if (!order.includes(i)) order.push(i);
    for (const i of order) {
      const id = String(channels[i].stream_id);
      requestEpg(server, id, () => setEpgTick((x) => x + 1));
    }
  }, [server, channels, top]);

  const progsFor = useCallback(
    (ch) => {
      const hit = epgCache.get(String(ch?.stream_id));
      return hit ? hit.rows.filter((p) => p.stop > p.start) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [epgTick],
  );

  const selCh = channels[row] || null;
  const selProgs = selCh ? progsFor(selCh) : null;
  const selProg = selProgs ? progAt(selProgs, cursor) : null;

  // Keep the selected programme inside the visible time window.
  const reveal = (start, stop) => {
    setWinStart((ws) => {
      const we = ws + winSecs;
      if (start < ws) return Math.max(slotFloor(start), slotFloor(now) - PAST_LIMIT);
      if (start >= we - SLOT / 2) return slotFloor(start) - SLOT;
      if (stop > we && start > ws + SLOT && stop - start < winSecs) return slotFloor(start) - SLOT;
      return ws;
    });
  };

  // D-pad handler called by the focus system while the grid has focus.
  // Returns true when handled; false lets spatial nav leave the grid (↑ at top).
  const move = (dir) => {
    if (!channels.length) return false;
    if (dir.dy !== 0) {
      const next = row + dir.dy;
      if (next < 0) return false;
      if (next >= channels.length) return true;
      setRow(next);
      return true;
    }
    const progs = selProgs || [];
    const cur = progAt(progs, cursor);
    if (dir.dx > 0) {
      const nxt = cur ? progs.find((p) => p.start >= cur.stop) : progs.find((p) => p.start > cursor);
      if (nxt) {
        setCursor(nxt.start + 1);
        reveal(nxt.start, nxt.stop);
      } else if (cursor + SLOT < winEnd + 6 * 3600) {
        // No guide data: step through empty 30-min slots.
        const c = slotFloor(cursor) + SLOT;
        setCursor(c + 1);
        reveal(c, c + SLOT);
      }
      return true;
    }
    const minTime = slotFloor(now) - PAST_LIMIT;
    const prev = cur ? [...progs].reverse().find((p) => p.stop <= cur.start) : [...progs].reverse().find((p) => p.stop <= cursor);
    if (prev && prev.stop > minTime) {
      setCursor(Math.max(prev.start, minTime) + 1);
      reveal(Math.max(prev.start, minTime), prev.stop);
    } else if (!cur && slotFloor(cursor) - SLOT >= minTime) {
      const c = slotFloor(cursor) - SLOT;
      setCursor(c + 1);
      reveal(c, c + SLOT);
    }
    return true;
  };
  const moveRef = useRef(move);
  moveRef.current = move;

  const setGridEl = (el) => {
    gridRef.current = el;
    if (el) el.__tvGridMove = (dir) => moveRef.current(dir);
  };

  // Seed focus on the grid once channels are there.
  useEffect(() => {
    if (!channels.length) return undefined;
    // Like the channel list: after the page opens or a category is picked,
    // focus goes to the grid (route auto-focus runs at 30/120/400 ms).
    const timers = [60, 450, 900].map((ms) =>
      window.setTimeout(() => {
        const el = gridRef.current;
        if (!el || el.classList.contains('tv-focused')) return;
        const cur = document.querySelector('.tv-focused');
        if (cur && cur.closest('.epg-page') && !cur.classList.contains('cat-chip') && !cur.classList.contains('back-btn')) return;
        setFocused(el, { native: false });
      }, ms),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.length > 0, catId]);

  const playSelected = () => {
    const ch = selCh;
    if (!ch || !server) return;
    const prog = selProg;
    if (prog && prog.stop <= now && String(ch.tv_archive) === '1') {
      const ts = ch.tv_archive_extension === 'ts';
      const url = liveCatchupUrl(server, ch.stream_id, { startEpoch: prog.start, endEpoch: prog.stop, ts });
      navigate(`/player?type=catchup&start=0&url=${encodeURIComponent(url)}`);
      return;
    }
    const categoryName = catName.get(String(ch.category_id)) || ch.category_name || '';
    pushRecentLive({ id: ch.stream_id, title: ch.name || '', image: ch.stream_icon || '', categoryId: ch.category_id, categoryName });
    setLiveZapList(
      channels.map((c) => ({
        id: String(c.stream_id),
        name: c.name || '',
        url: liveStreamTsUrl(server, c.stream_id),
        categoryName: catName.get(String(c.category_id)) || c.category_name || '',
      })),
    );
    setLiveZapMeta({
      catId: catId || '',
      categories: [
        { id: '', name: t('live.all') },
        ...visibleCats.map((c) => ({ id: String(c.category_id), name: c.category_name || String(c.category_id) })),
      ],
      adultSession: false,
    });
    setLastLiveChannel(String(ch.stream_id));
    const url = liveStreamTsUrl(server, ch.stream_id);
    navigate(`/player?type=live&id=${ch.stream_id}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(ch.name || '')}&from=guide`, { replace: true });
  };

  const slots = [];
  for (let s = winStart; s < winEnd; s += SLOT) slots.push(s);
  const x = (sec) => ((sec - winStart) / 60) * PX_PER_MIN;
  const nowX = now >= winStart && now < winEnd ? x(now) : null;

  return (
    <div className="epg-page">
      <div className="page-head">
        <button tabIndex={0} className="back-btn" onClick={() => navigate(-1)}>
          ← {t('common.back')}
        </button>
        <h1>{t('guide.title')}</h1>
        <span className="hint epg-help">{t('guide.help')}</span>
      </div>

      <div className="cat-bar">
        <GridChip id="epg-cat-fav" label={t('live.favorites')} selected={catId === CAT_FAVORITES} onClick={() => setCatId(CAT_FAVORITES)} />
        <GridChip id="epg-cat-all" label={t('live.all')} selected={catId === ''} onClick={() => setCatId('')} />
        {visibleCats.map((c) => (
          <GridChip
            key={c.category_id}
            id={`epg-cat-${c.category_id}`}
            label={c.category_name}
            selected={String(catId) === String(c.category_id)}
            onClick={() => setCatId(String(c.category_id))}
          />
        ))}
      </div>

      <div className="eg-info" aria-live="polite">
        {selCh ? (
          <>
            <div className="eg-info-ch">{selCh.name}</div>
            {selProg ? (
              <>
                <div className="eg-info-title">
                  {selProg.start <= now && selProg.stop > now ? <span className="eg-live-dot">● {t('live.now')}</span> : null}
                  {selProg.title}
                </div>
                <div className="eg-info-time">
                  {formatEpgTime(selProg.start)} – {formatEpgTime(selProg.stop)}
                  {selProg.stop <= now && String(selCh.tv_archive) === '1' ? ` · ${t('guide.catchupOk')}` : ''}
                </div>
                {selProg.description ? <div className="eg-info-desc">{selProg.description}</div> : null}
              </>
            ) : (
              <div className="eg-info-time">{selProgs ? t('live.noGuide') : t('live.loadingGuide')}</div>
            )}
          </>
        ) : null}
      </div>

      {catId !== CAT_FAVORITES && loading && !channels.length ? (
        <div className="eg-skeleton">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="eg-skel-row" />
          ))}
        </div>
      ) : error && !channels.length ? (
        <div className="state">
          {t('common.error')}
          <button tabIndex={0} className="btn-primary" style={{ marginTop: 16 }} onClick={reload}>
            {t('common.retry')}
          </button>
        </div>
      ) : !channels.length ? (
        <div className="state">{catId === CAT_FAVORITES ? t('live.noFavorites') : t('vod.noResults')}</div>
      ) : (
        <div ref={setGridEl} tabIndex={0} className="epg-grid" data-tv-grid="true" onClick={playSelected}>
          <div className="eg-timebar" style={{ paddingLeft: CHAN_COL }}>
            {slots.map((s) => (
              <div key={s} className="eg-slot" style={{ left: CHAN_COL + x(s), width: SLOT / 60 * PX_PER_MIN }}>
                {formatEpgTime(s)}
              </div>
            ))}
          </div>
          <div className="eg-rows">
            {shown.map((ch, i) => {
              const idx = top + i;
              const progs = progsFor(ch);
              const active = idx === row;
              return (
                <div key={ch.stream_id} className={`eg-row${active ? ' eg-row--active' : ''}`}>
                  <div className="eg-ch" style={{ width: CHAN_COL }}>
                    <span className="eg-ch-num">{idx + 1}</span>
                    {ch.stream_icon ? <img
                        className="eg-ch-logo"
                        src={ch.stream_icon}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={(e) => {
                          e.currentTarget.style.visibility = 'hidden';
                        }}
                      /> : null}
                    <span className="eg-ch-name">{ch.name}</span>
                  </div>
                  <div className="eg-track" style={{ width: trackW }}>
                    {progs === null ? (
                      <div className="eg-cell eg-cell--loading" style={{ left: 0, width: trackW }} />
                    ) : progs.length === 0 ? (
                      <div
                        className={`eg-cell eg-cell--empty${active ? ' eg-cell--sel' : ''}`}
                        style={{ left: 0, width: trackW }}
                      >
                        {t('live.noGuide')}
                      </div>
                    ) : (
                      progs
                        .filter((p) => p.stop > winStart && p.start < winEnd)
                        .map((p) => {
                          const l = Math.max(0, x(p.start));
                          const w = Math.max(4, Math.min(trackW, x(p.stop)) - l);
                          const sel = active && p.start <= cursor && p.stop > cursor;
                          const live = p.start <= now && p.stop > now;
                          return (
                            <div
                              key={`${p.start}-${p.stop}`}
                              className={`eg-cell${sel ? ' eg-cell--sel' : ''}${live ? ' eg-cell--now' : ''}${p.stop <= now ? ' eg-cell--past' : ''}`}
                              style={{ left: l, width: w - 3 }}
                            >
                              <span className="eg-cell-title">{p.title}</span>
                              {w > 120 ? <span className="eg-cell-time">{formatEpgTime(p.start)}</span> : null}
                            </div>
                          );
                        })
                    )}
                  </div>
                </div>
              );
            })}
            {nowX !== null ? <div className="eg-now-line" style={{ left: CHAN_COL + nowX }} /> : null}
          </div>
          <div className="eg-foot hint">
            {t('guide.position', row + 1, channels.length)}
          </div>
        </div>
      )}
    </div>
  );
}
