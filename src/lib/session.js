import { isAdultContent, isAdultTitle } from './adult.js';

// Session + local persistence (localStorage). Mirrors the Roku registry:
// WorkingUrl / Username / Password, plus continue-watching and favorites.
// Also keeps a multi-account list so the user can switch panels/users.

const KEYS = {
  session: 'swiftstv.session.v1',
  accounts: 'swiftstv.accounts.v1',
  continueWatching: 'swiftstv.continueWatching.v1',
  favorites: 'swiftstv.favorites.v1',
  recentLive: 'swiftstv.recentLive.v1',
  language: 'swiftstv.language.v1',
  hlsOnly: 'swiftstv.hlsOnlyChannels.v1',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / privacy mode — best effort only.
  }
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host || String(baseUrl || '');
  } catch {
    return String(baseUrl || '').replace(/^https?:\/\//i, '');
  }
}

/**
 * Same Xtream user = one account. Multi-DNS aliases (cvcplayer.us / cavctv.xyz / …)
 * used to create 3 identical rows because the id included the host.
 */
export function accountIdFor(_baseUrl, username) {
  return String(username || '').trim().toLowerCase();
}

/** Collapse legacy host-based duplicates (user@host) into one row per username. */
export function dedupeAccounts(list) {
  const byId = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (!a?.username) continue;
    const id = accountIdFor(a.baseUrl, a.username);
    const prev = byId.get(id);
    const score = Number(a.lastUsedAt) || 0;
    const prevScore = Number(prev?.lastUsedAt) || 0;
    if (!prev || score >= prevScore) {
      byId.set(id, {
        ...a,
        id,
        host: hostOf(a.baseUrl),
        label: a.label || prev?.label || a.username,
      });
    }
  }
  return [...byId.values()].sort(
    (x, y) => (Number(y.lastUsedAt) || 0) - (Number(x.lastUsedAt) || 0)
  );
}

export function getSession() {
  return read(KEYS.session, null);
}

export function saveSession(session) {
  const payload = {
    baseUrl: session.baseUrl,
    username: session.username,
    password: session.password,
    savedAt: Date.now(),
    user_info: session.user_info || null,
  };
  write(KEYS.session, payload);
  // Keep the multi-account book in sync whenever the active session is saved.
  upsertAccount(payload);
}

export function clearSession() {
  try {
    localStorage.removeItem(KEYS.session);
  } catch {}
}

// ---- Multi-account book ----------------------------------------------------

export function listAccounts() {
  const list = read(KEYS.accounts, []);
  const raw = Array.isArray(list) ? list : [];
  const deduped = dedupeAccounts(raw);
  // Persist migration once so Cuentas stops showing DNS-alias clones.
  if (
    deduped.length !== raw.length ||
    deduped.some((a, i) => a.id !== raw[i]?.id)
  ) {
    writeAccounts(deduped);
  }
  return deduped;
}

function writeAccounts(list) {
  write(KEYS.accounts, list);
}

/** Insert or update an account entry from a successful login / session save. */
export function upsertAccount(session, extras = {}) {
  if (!session?.baseUrl || !session?.username || !session?.password) return null;
  const id = accountIdFor(session.baseUrl, session.username);
  const prev = listAccounts();
  const existing = prev.find((a) => a.id === id);
  const next = {
    id,
    baseUrl: session.baseUrl,
    username: session.username,
    password: session.password,
    label: extras.label || existing?.label || session.username,
    host: hostOf(session.baseUrl),
    user_info: session.user_info || existing?.user_info || null,
    lastUsedAt: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
  };
  const list = [next, ...prev.filter((a) => a.id !== id)];
  writeAccounts(list);
  return next;
}

export function getAccount(id) {
  return listAccounts().find((a) => a.id === id) || null;
}

export function removeAccount(id) {
  writeAccounts(listAccounts().filter((a) => a.id !== id));
}

export function updateAccount(id, patch) {
  const list = listAccounts();
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const cur = list[idx];
  const next = {
    ...cur,
    ...patch,
    id:
      patch.baseUrl || patch.username
        ? accountIdFor(patch.baseUrl || cur.baseUrl, patch.username || cur.username)
        : cur.id,
    host: hostOf(patch.baseUrl || cur.baseUrl),
  };
  const cleaned = list.filter((a, i) => i !== idx && a.id !== next.id);
  cleaned.unshift(next);
  writeAccounts(cleaned);
  return next;
}

/** Ensure the currently saved session appears in the accounts list (migration). */
export function ensureActiveAccountListed() {
  const s = getSession();
  if (s?.baseUrl && s?.username && s?.password) upsertAccount(s);
}

export function getContinueWatching() {
  const list = read(KEYS.continueWatching, []);
  // Drop adult / live that may have been stored before the filters existed.
  // Live history lives in recentLive, not Home's "Seguir viendo".
  const clean = (Array.isArray(list) ? list : []).filter(
    (x) =>
      x?.id &&
      x.type !== 'live' &&
      x.type !== 'catchup' &&
      !isAdultContent(x.title, x.categoryName),
  );
  if (clean.length !== (list || []).length) write(KEYS.continueWatching, clean);
  return clean;
}

export function updateContinueWatching(item) {
  // Live → Recientes (LiveGuide). Adult → never on Home rails.
  if (!item || item.type === 'live' || item.type === 'catchup') return;
  if (isAdultContent(item.title, item.categoryName) || isAdultTitle(item.title)) return;
  let list = getContinueWatching();
  list = list.filter((x) => !(x.type === item.type && x.id === item.id));
  list.unshift({
    type: item.type,
    id: item.id,
    title: item.title,
    image: item.image,
    url: item.url || '',
    baseUrl: item.baseUrl,
    position: item.position || 0,
    duration: item.duration || 0,
    seriesId: item.seriesId || '',
    season: item.season || '',
    categoryName: item.categoryName || '',
    playedAt: Date.now(),
  });
  if (list.length > 20) list = list.slice(0, 20);
  write(KEYS.continueWatching, list);
}

export function removeContinueWatching(type, id) {
  const list = getContinueWatching().filter((x) => !(x.type === type && x.id === id));
  write(KEYS.continueWatching, list);
}

export function getFavorites() {
  const list = read(KEYS.favorites, []);
  return Array.isArray(list) ? list : [];
}

/** Favorites for one section (`live` | `vod` | `series`), adult-safe for Home rails. */
export function getFavoritesByType(type, { hideAdult = false } = {}) {
  let list = getFavorites().filter((x) => x.type === type);
  if (hideAdult) list = list.filter((x) => !isAdultContent(x.title, x.categoryName));
  return list;
}

export function isFavorite(type, id) {
  return getFavorites().some((x) => x.type === type && String(x.id) === String(id));
}

export function toggleFavorite(item) {
  let list = getFavorites();
  const exists = list.some((x) => x.type === item.type && String(x.id) === String(item.id));
  if (exists) {
    list = list.filter((x) => !(x.type === item.type && String(x.id) === String(item.id)));
  } else {
    list.unshift({
      type: item.type,
      id: String(item.id),
      title: item.title || '',
      image: item.image || '',
      categoryId: item.categoryId ? String(item.categoryId) : '',
      categoryName: item.categoryName || '',
      addedAt: Date.now(),
    });
    if (list.length > 100) list = list.slice(0, 100);
  }
  write(KEYS.favorites, list);
  return !exists;
}

const RECENT_LIVE_MAX = 24;

export function getRecentLive() {
  const list = read(KEYS.recentLive, []);
  const clean = (Array.isArray(list) ? list : []).filter(
    (x) => x?.id && !isAdultContent(x.title, x.categoryName),
  );
  if (clean.length !== (list || []).length) write(KEYS.recentLive, clean);
  return clean;
}

/** Record a live channel as recently watched. Adult titles/categories are ignored. */
export function pushRecentLive({ id, title, image, categoryId, categoryName }) {
  if (!id || isAdultContent(title, categoryName)) return;
  let list = getRecentLive().filter((x) => String(x.id) !== String(id));
  list.unshift({
    id: String(id),
    title: title || '',
    image: image || '',
    categoryId: categoryId ? String(categoryId) : '',
    categoryName: categoryName || '',
    playedAt: Date.now(),
  });
  if (list.length > RECENT_LIVE_MAX) list = list.slice(0, RECENT_LIVE_MAX);
  write(KEYS.recentLive, list);
}

export function getLanguage() {
  const lang = read(KEYS.language, null);
  return lang === 'en' ? 'en' : 'es';
}

export function saveLanguage(lang) {
  write(KEYS.language, lang === 'en' ? 'en' : 'es');
}

function getHlsOnlySet() {
  const raw = read(KEYS.hlsOnly, null);
  return Array.isArray(raw) ? new Set(raw) : new Set();
}

export function isHlsOnlyChannel(key) {
  if (!key) return false;
  return getHlsOnlySet().has(String(key));
}

export function markHlsOnlyChannel(key) {
  if (!key) return;
  const set = getHlsOnlySet();
  set.add(String(key));
  write(KEYS.hlsOnly, [...set]);
}

export function clearHlsOnlyChannel(key) {
  if (!key) return;
  const set = getHlsOnlySet();
  if (!set.delete(String(key))) return;
  write(KEYS.hlsOnly, [...set]);
}
