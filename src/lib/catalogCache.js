import { getLiveStreams, getVodStreams, getSeries } from './xtream.js';
import { normalizeSearch } from './searchText.js';

// Catalog cache for global search.
//
// The full VOD list on these panels is ~30 MB of JSON (8-15 s even on a good
// connection, much longer through the proxy / on a TV). We:
//  - keep only the fields search needs (name, ids, poster, category) plus a
//    pre-normalised `n` for fast accent-free matching,
//  - persist that slim copy in IndexedDB for a few hours, so only the first
//    search after a while pays the download,
//  - load the parts independently (live + series first, VOD after) so results
//    show up as soon as each part arrives.

const MEMORY_TTL_MS = 30 * 60 * 1000;
const DISK_TTL_MS = 6 * 60 * 60 * 1000;
const PARTS = ['live', 'series', 'vod'];
const DB_NAME = 'swiftstv-catalog';
const STORE = 'parts';

const memory = new Map(); // `${key}|${part}` -> { at, items }
const inflight = new Map(); // `${key}|${part}` -> Promise<items>

function cacheKey(server) {
  return `${String(server?.baseUrl || '').trim()}|${String(server?.username || '')
    .trim()
    .toLowerCase()}`;
}

function slim(part, list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r) continue;
    const name = String(r.name || '');
    if (part === 'series') {
      out.push({ series_id: r.series_id, name, cover: r.cover || '', category_id: r.category_id, n: normalizeSearch(name) });
    } else if (part === 'vod') {
      out.push({
        stream_id: r.stream_id,
        name,
        stream_icon: r.stream_icon || '',
        category_id: r.category_id,
        container_extension: r.container_extension || '',
        n: normalizeSearch(name),
      });
    } else {
      out.push({ stream_id: r.stream_id, name, stream_icon: r.stream_icon || '', category_id: r.category_id, n: normalizeSearch(name) });
    }
  }
  return out;
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

const FETCHERS = {
  live: (srv) => getLiveStreams(srv, undefined, { noCache: true, timeoutMs: 60000, throwOnError: true }),
  series: (srv) => getSeries(srv, undefined, { noCache: true, timeoutMs: 60000, throwOnError: true }),
  vod: (srv) => getVodStreams(srv, undefined, { noCache: true, timeoutMs: 120000, throwOnError: true }),
};

/** Load one catalog part (memory → IndexedDB → network). Rejects on failure. */
export function loadCatalogPart(server, part) {
  const key = `${cacheKey(server)}|${part}`;
  const mem = memory.get(key);
  if (mem && Date.now() - mem.at < MEMORY_TTL_MS) return Promise.resolve(mem.items);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const disk = await diskGet(key);
    if (disk && Array.isArray(disk.items) && disk.items.length && Date.now() - disk.at < DISK_TTL_MS) {
      memory.set(key, { at: Date.now(), items: disk.items });
      return disk.items;
    }
    const raw = await FETCHERS[part](server);
    const items = slim(part, raw);
    if (items.length) {
      memory.set(key, { at: Date.now(), items });
      diskPut(key, { at: Date.now(), items });
    }
    return items;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Progressive load: calls onPart(part, items|null, error?) as each part lands.
 * Live + series start together; VOD (the heavy one) starts after them so it
 * doesn't steal bandwidth from the quick results.
 */
export async function loadCatalogProgressive(server, onPart) {
  if (!server?.baseUrl) return;
  const run = (part) =>
    loadCatalogPart(server, part)
      .then((items) => onPart(part, items, null))
      .catch((err) => onPart(part, null, err || new Error('load failed')));
  await Promise.all([run('live'), run('series')]);
  await run('vod');
}

/** Back-compat: resolve all three parts at once. */
export async function loadCatalog(server) {
  const out = { live: [], vod: [], series: [] };
  if (!server?.baseUrl) return out;
  await loadCatalogProgressive(server, (part, items) => {
    if (items) out[part] = items;
  });
  return out;
}

/** Warm the cheap parts (live + series) in the background while Home is idle. */
export function prefetchCatalog(server) {
  if (!server?.baseUrl) return;
  loadCatalogPart(server, 'live').catch(() => {});
  loadCatalogPart(server, 'series').catch(() => {});
}

/** Drop the in-memory copy; `disk: true` also wipes IndexedDB (logout). */
export function clearCatalogCache({ disk = false } = {}) {
  memory.clear();
  inflight.clear();
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
