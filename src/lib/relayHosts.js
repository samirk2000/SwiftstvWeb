// Panels whose HTTPS host sits behind a Cloudflare "Just a moment…" challenge
// (e.g. cavctv.xyz / cvcplayertv.xyz) answer 403 to any non-browser client —
// including our VPS relay — while their plain-HTTP origin (port 80/8080, XUI)
// answers normally. For those hosts the relay must fetch the http:// variant
// (the relay's job is exactly HTTP→HTTPS). We remember such hosts so API calls
// and VOD/series streams go straight to the working route next time.
const KEY = 'swiftstv.httpRelayHosts.v1';
const MAX_HOSTS = 30;

let hosts = null;

function load() {
  if (hosts) return hosts;
  hosts = new Set();
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) list.forEach((h) => typeof h === 'string' && hosts.add(h));
  } catch {
    /* ignore */
  }
  return hosts;
}

function save() {
  try {
    globalThis.localStorage &&
      globalThis.localStorage.setItem(KEY, JSON.stringify([...load()].slice(-MAX_HOSTS)));
  } catch {
    /* ignore */
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True once we've seen this host's HTTPS blocked by a challenge but HTTP work. */
export function prefersHttpRelay(url) {
  const h = hostOf(url);
  return Boolean(h) && load().has(h);
}

export function markHttpRelay(url) {
  const h = hostOf(url);
  if (!h || load().has(h)) return;
  load().add(h);
  save();
}

export function unmarkHttpRelay(url) {
  const h = hostOf(url);
  if (!h || !load().has(h)) return;
  load().delete(h);
  save();
}

/** https://host[:443]/path → http://host/path (default port). Non-https → ''. */
export function httpVariant(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    u.protocol = 'http:';
    u.port = '';
    return u.toString();
  } catch {
    return '';
  }
}

/** Cloudflare / bot-challenge interstitial (never real panel data). */
export function isChallengePage(status, text) {
  if (status && status !== 403 && status !== 503 && status !== 429) return false;
  return /<title>\s*Just a moment|challenge-platform|cf-chl-|cf_chl_|Attention Required! \| Cloudflare/i.test(
    String(text || '').slice(0, 6000)
  );
}

export function __resetRelayHostsForTests() {
  hosts = null;
}
