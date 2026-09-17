/** Live channel zap list + category context for the in-player overlay. */

const LIST_KEY = 'swiftstv.liveZap.v1';
const LAST_KEY = 'swiftstv.liveLast.v1';
const META_KEY = 'swiftstv.liveZapMeta.v1';

function read(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** @param {{ id: string, name: string, url: string }[]} channels */
export function setLiveZapList(channels) {
  const list = (channels || [])
    .filter((c) => c && c.id && c.url)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name || ''),
      url: String(c.url),
    }));
  write(LIST_KEY, list);
  return list;
}

export function getLiveZapList() {
  const list = read(LIST_KEY, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Categories available while zapping from the player overlay.
 * @param {{ categories: { id: string, name: string }[], catId: string }} meta
 */
export function setLiveZapMeta(meta) {
  const categories = Array.isArray(meta?.categories)
    ? meta.categories
        .filter((c) => c && (c.id != null || c.name))
        .map((c) => ({ id: String(c.id ?? ''), name: String(c.name || '') }))
    : [];
  write(META_KEY, {
    categories,
    catId: meta?.catId != null ? String(meta.catId) : '',
  });
}

export function getLiveZapMeta() {
  const meta = read(META_KEY, null);
  if (!meta || typeof meta !== 'object') return { categories: [], catId: '' };
  return {
    categories: Array.isArray(meta.categories) ? meta.categories : [],
    catId: meta.catId != null ? String(meta.catId) : '',
  };
}

export function setLiveZapCatId(catId) {
  const meta = getLiveZapMeta();
  write(META_KEY, { ...meta, catId: String(catId ?? '') });
}

/** Move ±1 category in the saved list. Returns next cat or null. */
export function zapCategoryRelative(delta) {
  const meta = getLiveZapMeta();
  const cats = meta.categories || [];
  if (cats.length < 2) return null;
  let idx = cats.findIndex((c) => String(c.id) === String(meta.catId));
  if (idx < 0) idx = 0;
  const next = cats[(idx + delta + cats.length * 10) % cats.length];
  if (!next) return null;
  setLiveZapCatId(next.id);
  return next;
}

export function setLastLiveChannel(id) {
  if (id == null) return;
  write(LAST_KEY, String(id));
}

export function getLastLiveChannel() {
  return read(LAST_KEY, '') || '';
}

export function findZapIndex(id) {
  const list = getLiveZapList();
  return list.findIndex((c) => String(c.id) === String(id));
}

export function zapRelative(id, delta) {
  const list = getLiveZapList();
  if (!list.length) return null;
  let idx = findZapIndex(id);
  if (idx < 0) idx = 0;
  const next = list[(idx + delta + list.length * 10) % list.length];
  return next || null;
}

/** Match by 1-based list number or by stream id digits. */
export function zapByNumber(numStr) {
  const list = getLiveZapList();
  if (!list.length || !numStr) return null;
  const n = Number(numStr);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1 && n <= list.length) return list[n - 1];
  return list.find((c) => String(c.id) === String(n)) || null;
}
