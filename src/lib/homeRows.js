// Netflix-style Home rows built from plain Xtream data.
//
// Row *plans* come from the (small) category lists; each row's items are a
// per-category get_vod_streams / get_series call, fetched lazily when the row
// scrolls near the screen. Slim results are kept in memory and localStorage
// (per account, 3 h) so the next Home opens instantly even on slow panels.
import { getVodCategories, getSeriesCategories, getVodStreams, getSeries } from './xtream.js';
import { isAdultCategory, isAdultContent } from './adult.js';
import { isCategoryLocked } from './parental.js';
import { activeAccountId } from './session.js';
import { cleanTitle } from './text.js';

const KEY = 'swiftstv.homeRows.v1';
const TTL_MS = 3 * 60 * 60 * 1000;
const ROW_LIMIT = 40;
const MAX_ROWS = 9;

const mem = new Map(); // `${aid}|${rowKey}` -> { at, items }
let planMem = null; // { aid, at, rows }

function readDisk() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeDisk(aid, patch) {
  try {
    const all = readDisk();
    // Only keep the active account's rows (bounded size).
    const cur = all[aid] && typeof all[aid] === 'object' ? all[aid] : {};
    localStorage.setItem(KEY, JSON.stringify({ [aid]: { ...cur, ...patch } }));
  } catch {
    /* quota: memory cache still works */
  }
}

function fresh(entry) {
  return entry && Date.now() - Number(entry.at || 0) < TTL_MS;
}

/** "ESTRENOS CARTELERA (E)" -> "Estrenos cartelera" (TV-friendly row title). */
export function prettyCategory(name) {
  let s = cleanTitle(String(name || ''))
    .replace(/\s*\((?:[A-Z]{1,2})\)\s*$/u, '')
    .replace(/^\s*\d+\s*[.)-]\s*/u, '')
    .replace(/^VOD\s+/iu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!s) return String(name || '');
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters && letters === letters.toUpperCase()) {
    s = s.toLowerCase().replace(/^\p{L}/u, (c) => c.toUpperCase());
    // Keep common acronyms / brands readable.
    s = s.replace(/\b(4k|3d|hbo|tv|hd|uhd|mgm|eng|lat|cast|dc|usa|uk)\b/gi, (m) => m.toUpperCase());
  }
  return s;
}

const RECENT_RE = /reci[eé]n\s*agregad|recently\s*added|agregad[oa]s?\s*reciente|novedades/i;
const PREMIERE_RE = /estreno|premiere|cartelera/i;
const SKIP_RE = /\bcam\b|\(k\)|xxx|adult/i;

function usable(c) {
  return c && c.category_id != null && !isAdultCategory(c.category_name) && !isCategoryLocked(c.category_id);
}

/** Decide which rows Home shows. Cheap: two small category calls (cached). */
export async function loadHomePlan(server) {
  const aid = activeAccountId();
  if (planMem && planMem.aid === aid && fresh(planMem)) return planMem.rows;
  const disk = readDisk()[aid];
  if (disk?.plan && fresh(disk.plan)) {
    planMem = { aid, at: disk.plan.at, rows: disk.plan.rows };
    return disk.plan.rows;
  }
  const [vodCats, seriesCats] = await Promise.all([
    getVodCategories(server).catch(() => []),
    getSeriesCategories(server).catch(() => []),
  ]);
  const vods = (vodCats || []).filter(usable);
  const sers = (seriesCats || []).filter(usable);
  const used = new Set();
  const rows = [];
  const add = (kind, c, title) => {
    if (!c) return;
    const key = `${kind}:${c.category_id}`;
    if (used.has(key)) return;
    used.add(key);
    rows.push({ key, kind, catId: String(c.category_id), title: title || prettyCategory(c.category_name) });
  };

  const recent = vods.find((c) => RECENT_RE.test(c.category_name)) ||
    vods.find((c) => PREMIERE_RE.test(c.category_name) && !SKIP_RE.test(c.category_name));
  add('vod', recent, 'Películas recién agregadas');
  const seriesNew = sers.find((c) => PREMIERE_RE.test(c.category_name) || RECENT_RE.test(c.category_name)) || sers[0];
  add('series', seriesNew, 'Series nuevas');
  const premieres = vods.filter((c) => PREMIERE_RE.test(c.category_name) && !SKIP_RE.test(c.category_name));
  for (const c of premieres.slice(0, 2)) add('vod', c);
  // Then panel order, alternating movies and series.
  const restV = vods.filter((c) => !SKIP_RE.test(c.category_name));
  const restS = sers.slice();
  let i = 0;
  while (rows.length < MAX_ROWS && (restV.length || restS.length) && i < 400) {
    const c = i % 3 === 2 ? restS.shift() : restV.shift();
    if (c) add(i % 3 === 2 ? 'series' : 'vod', c);
    i += 1;
  }
  planMem = { aid, at: Date.now(), rows };
  writeDisk(aid, { plan: { at: planMem.at, rows } });
  return rows;
}

function slimVod(r) {
  return {
    kind: 'vod',
    id: String(r.stream_id),
    name: r.name || '',
    img: r.stream_icon || '',
    added: Number(r.added) || 0,
    rating: Number(r.rating) || 0,
    year: r.year ? String(r.year).slice(0, 4) : '',
    plot: typeof r.plot === 'string' ? r.plot.slice(0, 280) : '',
    ext: r.container_extension || '',
    cat: r.category_id != null ? String(r.category_id) : '',
    catName: r.category_name || '',
  };
}

function slimSeries(r) {
  let backdrop = r.backdrop_path;
  if (Array.isArray(backdrop)) backdrop = backdrop[0];
  return {
    kind: 'series',
    id: String(r.series_id),
    name: r.name || '',
    img: r.cover || '',
    backdrop: typeof backdrop === 'string' ? backdrop : '',
    added: Number(r.last_modified) || 0,
    rating: Number(r.rating) || 0,
    year: String(r.release_date || r.releaseDate || r.year || '').slice(0, 4),
    plot: typeof r.plot === 'string' ? r.plot.slice(0, 280) : '',
    genre: r.genre || '',
    cat: r.category_id != null ? String(r.category_id) : '',
    catName: r.category_name || '',
  };
}

/** Items for one row (sorted newest first, adult-free, capped). */
export async function loadRowItems(server, row) {
  const aid = activeAccountId();
  const mk = `${aid}|${row.key}`;
  const hit = mem.get(mk);
  if (fresh(hit)) return hit.items;
  const disk = readDisk()[aid]?.rows?.[row.key];
  if (fresh(disk)) {
    mem.set(mk, disk);
    return disk.items;
  }
  const raw =
    row.kind === 'series'
      ? await getSeries(server, row.catId, { throwOnError: true, timeoutMs: 45000 })
      : await getVodStreams(server, row.catId, { throwOnError: true, timeoutMs: 45000 });
  const items = (raw || [])
    .map(row.kind === 'series' ? slimSeries : slimVod)
    .filter((x) => x.id && x.name && !isAdultContent(x.name, x.catName))
    .sort((a, b) => b.added - a.added)
    .slice(0, ROW_LIMIT);
  const entry = { at: Date.now(), items };
  mem.set(mk, entry);
  const cur = readDisk()[aid]?.rows || {};
  const kept = Object.entries(cur)
    .filter(([k, v]) => k !== row.key && fresh(v))
    .sort((a, b) => Number(b[1].at) - Number(a[1].at))
    .slice(0, 13);
  writeDisk(aid, { rows: { ...Object.fromEntries(kept), [row.key]: entry } });
  return items;
}

/** Same category as a title, for "Más como esto". */
export async function loadSimilar(server, kind, catId, excludeId) {
  if (!catId) return [];
  const items = await loadRowItems(server, { key: `${kind}:${catId}`, kind, catId: String(catId) });
  return items.filter((x) => String(x.id) !== String(excludeId)).slice(0, 20);
}

export function clearHomeRows() {
  mem.clear();
  planMem = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
