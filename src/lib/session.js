// Session + local persistence (localStorage). Mirrors the Roku registry:
// WorkingUrl / Username / Password, plus continue-watching and favorites.
// Also keeps a multi-account list so the user can switch panels/users.

const KEYS = {
  session: 'swiftstv.session.v1',
  accounts: 'swiftstv.accounts.v1',
  continueWatching: 'swiftstv.continueWatching.v1',
  favorites: 'swiftstv.favorites.v1',
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

/** Stable id for a credentials pair (user @ panel host). */
export function accountIdFor(baseUrl, username) {
  const u = String(username || '').trim().toLowerCase();
  const h = hostOf(baseUrl).toLowerCase();
  return `${u}@${h}`;
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
  return Array.isArray(list) ? list : [];
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
  return read(KEYS.continueWatching, []);
}

export function updateContinueWatching(item) {
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
  return read(KEYS.favorites, []);
}

export function isFavorite(type, id) {
  return getFavorites().some((x) => x.type === type && x.id === id);
}

export function toggleFavorite(item) {
  let list = getFavorites();
  const exists = list.some((x) => x.type === item.type && x.id === item.id);
  if (exists) {
    list = list.filter((x) => !(x.type === item.type && x.id === item.id));
  } else {
    list.unshift({
      type: item.type,
      id: item.id,
      title: item.title,
      image: item.image,
      addedAt: Date.now(),
    });
  }
  write(KEYS.favorites, list);
  return !exists;
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
