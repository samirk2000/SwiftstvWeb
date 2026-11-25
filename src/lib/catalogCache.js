import {
  getLiveStreams,
  getVodStreams,
  getSeries,
  getLiveCategories,
  getVodCategories,
  getSeriesCategories,
} from './xtream.js';
import { normalizeSearch } from './searchText.js';
import { isAdultCategory, isAdultTitle } from './adult.js';

// Search index (client side, per device).
//
// The panels are slow: a full list (get_series / get_vod_streams) can take 1-4
// minutes and a single category anywhere from 1 s to 60 s. Searching "live"
// against the panel is never going to be instant, so we keep a slim index
// (name, id, poster, category, normalised name) in IndexedDB and:
//  - serve whatever index we have IMMEDIATELY (even if it is old), then refresh
//    it in the background (stale-while-revalidate);
//  - warm all three parts in the background after login (warmCatalog), pausing
//    while a video is playing so streams keep the bandwidth;
//  - build VOD (and series, if the full list fails) category by category,
//    saving progress, so results appear while it builds, an interrupted build
//    resumes, and a TV never has to parse a 30 MB JSON in one go.
// Nothing is stored server side and no credentials are written to the index.

const FRESH_MS = 6 * 60 * 60 * 1000; // refresh in the background after this
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // still shown up to this age
const PARTIAL_RESUME_MS = 24 * 60 * 60 * 1000; // resume an unfinished build
const PARTS = ['live', 'series', 'vod'];
const DB_NAME = 'swiftstv-catalog';
const STORE = 'parts';
const CAT_CONCURRENCY = 2;
const SAVE_EVERY = 4; // persist a partial index every N categories

// key -> { at, items, partial, done:Set }
const memory = new Map();
const refreshing = new Map(); // key -> Promise
const listeners = new Map(); // key -> Set<fn(items, meta)>

function cacheKey(server, part) {
  return `${String(server?.baseUrl || '').trim()}|${String(server?.username || '')
    .trim()
    .toLowerCase()}|${part}`;
}

function slimOne(part, r, catName) {
  if (!r) return null;
  const name = String(r.name || '');
  const a = isAdultCategory(catName || r.category_name || '') || isAdultTitle(name) ? 1 : 0;
  if (part === 'series') {
    return { series_id: r.series_id, name, cover: r.cover || '', category_id: r.category_id, n: normalizeSearch(name), a };
  }
  const o = { stream_id: r.stream_id, name, stream_icon: r.stream_icon || '', category_id: r.category_id, n: normalizeSearch(name), a };
  if (part === 'vod') o.container_extension = r.container_extension || '';
  return o;
}

function idOf(it) {
  return String(it.series_id ?? it.stream_id ?? '');
}

// ---- IndexedDB (best effort; silently skipped where unsupported) ----------
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE);
        } catch {
          /* exists */
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function diskGet(id) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function diskPut(id, value) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, id);
  } catch {
    /* quota / private mode */
  }
}

function emit(key) {
  const entry = memory.get(key);
  const set = listeners.get(key);
  if (!entry || !set) return;
  const meta = { at: entry.at, partial: !!entry.partial, stale: Date.now() - entry.at > FRESH_MS };
  for (const fn of [...set]) {
    try {
      fn(entry.items, meta);
    } catch {
      /* listener errors must not break the build */
    }
  }
}

function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

function setEntry(key, entry, persist) {
  memory.set(key, entry);
  if (persist) {
    diskPut(key, { at: entry.at, items: entry.items, partial: !!entry.partial, done: [...(entry.done || [])] });
  }
  emit(key);
}

async function loadFromDisk(key) {
  if (memory.has(key)) return memory.get(key);
  const disk = await diskGet(key);
  if (disk && Array.isArray(disk.items) && Date.now() - (disk.at || 0) < MAX_AGE_MS) {
    const entry = { at: disk.at, items: disk.items, partial: !!disk.partial, done: new Set(disk.done || []) };
    memory.set(key, entry);
    return entry;
  }
  return null;
}

// Wait while a video is playing (the player owns the bandwidth / the panel's
// single connection on cheap accounts) — background builds resume after.
function waitUntilIdle() {
  return new Promise((resolve) => {
    const check = () => {
      const p = typeof location !== 'undefined' ? location.pathname : '';
      if (!p.startsWith('/player')) resolve();
      else setTimeout(check, 5000);
    };
    check();
  });
}

const CATEGORY_FETCHERS = {
  live: (srv) => getLiveCategories(srv),
  series: (srv) => getSeriesCategories(srv),
  vod: (srv) => getVodCategories(srv),
};
const LIST_FETCHERS = {
  live: (srv, cat, opts) => getLiveStreams(srv, cat, opts),
  series: (srv, cat, opts) => getSeries(srv, cat, opts),
  vod: (srv, cat, opts) => getVodStreams(srv, cat, opts),
};
// Full lists: live is quick, series is ~1-2 min on slow panels; VOD is built
// per category straight away (huge list, and per-category resumes).
const FULL_TIMEOUT = { live: 120000, series: 240000 };

async function categoryNames(server, part) {
  try {
    const cats = await CATEGORY_FETCHERS[part](server);
    const map = new Map();
    for (const c of cats || []) map.set(String(c.category_id), String(c.category_name || ''));
    return map;
  } catch {
    return new Map();
  }
}

async function buildFull(server, part, key) {
  const names = await categoryNames(server, part);
  const raw = await LIST_FETCHERS[part](server, undefined, {
    noCache: true,
    timeoutMs: FULL_TIMEOUT[part],
    throwOnError: true,
  });
  const items = [];
  const seen = new Set();
  for (const r of raw || []) {
    const it = slimOne(part, r, names.get(String(r?.category_id)));
    if (!it) continue;
    const id = idOf(it);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(it);
  }
  if (!items.length) throw new Error('empty list');
  setEntry(key, { at: Date.now(), items, partial: false, done: new Set() }, true);
  return items;
}

async function buildByCategory(server, part, key) {
  const names = await categoryNames(server, part);
  if (!names.size) throw new Error('no categories');
  const prev = memory.get(key);
  // Resume an unfinished build from the last day; otherwise start fresh but
  // keep showing the previous (complete) index until the new one is done.
  const resume = prev && prev.partial && Date.now() - prev.at < PARTIAL_RESUME_MS;
  const done = resume ? new Set(prev.done) : new Set();
  const items = resume ? [...prev.items] : [];
  const seen = new Set(items.map(idOf));
  const queue = [...names.keys()].filter((id) => !done.has(id) && !isAdultCategory(names.get(id)));
  let sinceSave = 0;
  let failures = 0;
  const showPartial = () => !prev || prev.partial || resume;
  const flush = (final) => {
    const entry = { at: Date.now(), items: [...items], partial: !final, done: new Set(done) };
    // A complete (older) index stays on screen until the rebuild finishes.
    if (final || showPartial()) setEntry(key, entry, true);
  };
  const worker = async () => {
    while (queue.length) {
      await waitUntilIdle();
      const cat = queue.shift();
      try {
        const list = await LIST_FETCHERS[part](server, cat, { noCache: true, timeoutMs: 90000, throwOnError: true });
        for (const r of list || []) {
          const it = slimOne(part, r, names.get(cat));
          if (!it) continue;
          const id = idOf(it);
          if (seen.has(id)) continue;
          seen.add(id);
          items.push(it);
        }
        done.add(cat);
      } catch {
        failures += 1;
      }
      sinceSave += 1;
      if (sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        flush(false);
      }
    }
  };
  await Promise.all(Array.from({ length: CAT_CONCURRENCY }, worker));
  // A few failed categories are retried on the next refresh (they stay out of
  // `done`); the index is still marked complete enough to use.
  const complete = failures === 0 || done.size >= names.size * 0.9;
  if (!items.length) throw new Error('empty index');
  const entry = { at: Date.now(), items, partial: !complete, done };
  setEntry(key, entry, true);
  return items;
}

function refreshPart(server, part) {
  const key = cacheKey(server, part);
  if (refreshing.has(key)) return refreshing.get(key);
  const p = (async () => {
    await waitUntilIdle();
    if (part === 'vod') return buildByCategory(server, part, key);
    try {
      return await buildFull(server, part, key);
    } catch (err) {
      if (part === 'live') throw err;
      return buildByCategory(server, part, key);
    }
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, p);
  return p;
}

function needsRefresh(entry) {
  return !entry || entry.partial || Date.now() - entry.at > FRESH_MS;
}

/**
 * Load one part: resolves with what we have now (memory/IndexedDB, even old),
 * refreshing in the background; with nothing cached it waits for the network
 * (or the first partial results of a per-category build). Rejects on failure.
 */
export async function loadCatalogPart(server, part) {
  const key = cacheKey(server, part);
  const entry = await loadFromDisk(key);
  if (entry && entry.items.length) {
    if (needsRefresh(entry)) refreshPart(server, part).catch(() => {});
    return entry.items;
  }
  return refreshPart(server, part);
}

/**
 * Progressive load: calls onPart(part, items|null, error?, meta?) as each part
 * lands — first from the saved index, then again whenever a background refresh
 * or a per-category build adds results. Returns an unsubscribe function.
 */
export function loadCatalogProgressive(server, onPart) {
  if (!server?.baseUrl) return () => {};
  const unsubs = [];
  let stopped = false;
  for (const part of PARTS) {
    const key = cacheKey(server, part);
    unsubs.push(
      subscribe(key, (items, meta) => {
        if (!stopped) onPart(part, items, null, meta);
      })
    );
  }
  (async () => {
    // Saved index first for all parts (instant), then the network.
    for (const part of PARTS) {
      const key = cacheKey(server, part);
      const entry = await loadFromDisk(key);
      if (stopped) return;
      if (entry && entry.items.length) {
        onPart(part, entry.items, null, { at: entry.at, partial: !!entry.partial, stale: needsRefresh(entry) });
      }
    }
    const run = (part) =>
      loadCatalogPart(server, part)
        .then((items) => {
          if (!stopped) onPart(part, items, null, { at: memory.get(cacheKey(server, part))?.at, partial: !!memory.get(cacheKey(server, part))?.partial });
        })
        .catch((err) => {
          if (stopped) return;
          const have = memory.get(cacheKey(server, part));
          if (have && have.items.length) onPart(part, have.items, null, { at: have.at, partial: true });
          else onPart(part, null, err || new Error('load failed'));
        });
    await Promise.all([run('live'), run('series')]);
    await run('vod');
  })();
  return () => {
    stopped = true;
    unsubs.forEach((u) => u());
  };
}

/** Back-compat: resolve all three parts at once. */
export async function loadCatalog(server) {
  const out = { live: [], vod: [], series: [] };
  if (!server?.baseUrl) return out;
  for (const part of PARTS) {
    try {
      out[part] = await loadCatalogPart(server, part);
    } catch {
      /* keep [] */
    }
  }
  return out;
}

/** Warm the whole index in the background (after login / while Home is idle). */
export function prefetchCatalog(server) {
  if (!server?.baseUrl) return;
  (async () => {
    for (const part of PARTS) {
      try {
        await loadCatalogPart(server, part);
        const key = cacheKey(server, part);
        const r = refreshing.get(key);
        if (r) await r.catch(() => {});
      } catch {
        /* next part */
      }
    }
  })();
}

/** Drop the in-memory copy; `disk: true` also wipes IndexedDB (logout). */
export function clearCatalogCache({ disk = false } = {}) {
  memory.clear();
  refreshing.clear();
  if (!disk) return;
  openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    } catch {
      /* ignore */
    }
  });
}

export { PARTS };
