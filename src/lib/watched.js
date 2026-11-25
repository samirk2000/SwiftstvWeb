// Watched episodes / movies, per account (localStorage).
// { [accountId]: { "<type>:<id>": epochMs } } — capped so it never grows unbounded.
import { activeAccountId } from './session.js';

const KEY = 'swiftstv.watched.v1';
const MAX = 3000;

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function mine() {
  const aid = activeAccountId();
  if (!aid) return null;
  const store = readStore();
  return { aid, store, map: store[aid] && typeof store[aid] === 'object' ? store[aid] : {} };
}

export function isWatched(type, id) {
  const m = mine();
  return Boolean(m && m.map[`${type}:${id}`]);
}

export function getWatchedMap() {
  return mine()?.map || {};
}

export function markWatched(type, id) {
  const m = mine();
  if (!m || !id) return;
  const k = `${type}:${id}`;
  if (m.map[k]) return;
  let next = { ...m.map, [k]: Date.now() };
  const keys = Object.keys(next);
  if (keys.length > MAX) {
    keys.sort((a, b) => next[a] - next[b]);
    next = Object.fromEntries(keys.slice(keys.length - MAX).map((x) => [x, next[x]]));
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...m.store, [m.aid]: next }));
  } catch {
    /* quota */
  }
}
