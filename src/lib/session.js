// Session + local persistence (localStorage). Mirrors the Roku registry:
// WorkingUrl / Username / Password, plus continue-watching and favorites.

const KEYS = {
  session: 'swiftstv.session.v1',
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

export function getSession() {
  return read(KEYS.session, null);
}

export function saveSession(session) {
  write(KEYS.session, {
    baseUrl: session.baseUrl,
    username: session.username,
    password: session.password,
    savedAt: Date.now(),
    user_info: session.user_info || null,
  });
}

export function clearSession() {
  try {
    localStorage.removeItem(KEYS.session);
  } catch {}
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
    // Keep the raw (un-proxied) Xtream URL so Home's "resume" can rebuild the
    // player route. It's stored per-playback; absent items fall back to
    // reconstruction from type/id + session.
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

// ---- "HLS-only" channel memory -------------------------------------------
// Some live channels CONNECT on the panel and download endlessly via the
// continuous .ts, but mpegts.js never produces playback on certain browsers
// (and the dirty MSE teardown can leave the HLS fallback unable to attach on
// the same element). Once a channel falls back to HLS, remember it so the next
// zap goes DIRECTLY to HLS (the route that historically played those channels),
// skipping the 12s mpegts wait and the broken transition. The memory is cleared
// when the HLS fallback itself fails (so a Retry re-tries mpegts).
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
