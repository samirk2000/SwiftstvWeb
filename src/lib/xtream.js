// Xtream client — a fetch wrapper around the Xtream API contract.
// Replicates the Android/Roku port: actions, panel JSON wrappers, HTML
// (bad login / expired) handling, in-memory caching with a short TTL, and
// non-cached playback URLs.
//
// NOTE: Stream URLs (live/movie/series) are intentionally NOT cached. The
// returned <video> src carries the working baseUrl, username and password
// embedded, matching Xtream's {server}/live|movie|series/U/P/ID.ext schema.

import { getSession, saveSession, clearSession } from './session.js';
import { corsFetch } from './cors.js';

// Derive a clean `http(s)://host[:port]` base from a URL that actually
// succeeded (so we persist HTTPS when the panel only accepted it over TLS).
function effectiveBaseUrl(workedUrl) {
  try {
    const u = new URL(workedUrl || '');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const port = u.port ? `:${u.port}` : '';
      return `${u.protocol}//${u.hostname}${port}`;
    }
  } catch {}
  return '';
}

export const SERVER_INFO = {
  INVALID: 'invalid',
  EXPIRED: 'expired',
  BANNED: 'banned',
  DISABLED: 'disabled',
  NETWORK: 'network',
  PARSE: 'parse',
  EMPTY: 'empty',
  HTTP: 'http',
  NO_CONFIG: 'no-config',
};

const TTL = 60 * 1000; // 60s in-memory TTL (matches Android short-TTL caching).

const cache = new Map();

function cacheKey(action, params) {
  const q = params ? Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&') : '';
  return `${action}?${q}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
  // Bound the cache size.
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// Panels often return an HTML debug page (HTTP 200) with no JSON for bad
// login / expired accounts. Detect and classify it exactly like Roku's
// loginDetectXuiHint, but never on valid JSON responses.
export function detectHtmlLoginHint(text) {
  if (!text || typeof text !== 'string') return '';
  const lower = text.toLowerCase();
  if (lower.indexOf('<html') < 0 && lower.indexOf('<h2') < 0 && lower.indexOf('<!doctype') < 0) return '';
  if (/invalid_credentials|username or password is invalid/.test(lower)) return SERVER_INFO.INVALID;
  if (/line has expired|>expired<|expired<\/h/.test(lower)) return SERVER_INFO.EXPIRED;
  if (/banned/.test(lower)) return SERVER_INFO.BANNED;
  if (/disabled/.test(lower)) return SERVER_INFO.DISABLED;
  // False-positive guard: an infrastructure/WAF page (nginx 403/404/502/lb,
  // "Forbidden", "Access Denied", captcha, Cloudflare "attention required") is
  // NOT bad credentials. Report it as HTTP so the UI shows a network message.
  if (
    /403|404|502|503|504\b/.test(lower) ||
    /forbidden|access.?denied|too many requests|attention required|just a moment|not found|gateway|cdn\b|captcha/.test(lower)
  ) {
    return SERVER_INFO.HTTP;
  }
  return SERVER_INFO.INVALID; // Unknown HTML page == bad credentials.
}

// Parse a JSON body that may:
//  - be a plain array (most category / stream lists),
//  - be wrapped in { categories: [...] }, { channels: [...] },
//    { epg_listings: [...] }, { streams: [...] }, etc.
export function parseXtreamList(parsed, fallbackKey = '') {
  if (parsed === null || parsed === undefined) return [];
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'object') {
    const keys = ['categories', 'channels', 'streams', 'epg_listings', fallbackKey];
    for (const k of keys) {
      if (k && Array.isArray(parsed[k])) return parsed[k];
    }
    return [];
  }
  return [];
}

function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || '').trim();
  if (!url) return '';
  while (url.length > 0 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function buildPlayerApiUrl(baseUrl, username, password, action = '', params = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const qs = new URLSearchParams();
  qs.set('username', username);
  qs.set('password', password);
  if (action) qs.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return `${base || ''}/player_api.php?${qs.toString()}`;
}

// --- Login / status -----------------------------------------------------

export async function login(server) {
  if (!server || !server.baseUrl || !server.username || !server.password) {
    return { ok: false, status: SERVER_INFO.NO_CONFIG };
  }
  const url = buildPlayerApiUrl(server.baseUrl, server.username, server.password);
  let text = '';
  let status = 0;
  let via = '';
  let resUrl = '';
  try {
    // server.via === 'proxy' forces the /proxy route (used by the failover
    // ranking); otherwise corsFetch applies direct-first HTTPS strategy.
    const res = await corsFetch(url, { userAgent: 'IPTVSmartersPlayer', forceProxy: server.via === 'proxy' });
    text = res.text;
    status = res.status;
    via = res.via;
    resUrl = res.url || url;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[login] network error', server.baseUrl, String(err?.message || err));
    return { ok: false, status: SERVER_INFO.NETWORK, error: err };
  }

  // Non-2xx from the panel (403/404/502/…) is a server/WAF/network problem,
  // NOT bad credentials — report it separately so the UI doesn't say
  // "invalid username/password" when the panel is blocking us.
  if (status && (status < 200 || status >= 300)) {
    // eslint-disable-next-line no-console
    console.warn('[login] non-2xx', server.baseUrl, status, 'via', via, '->', text.slice(0, 140));
    return { ok: false, status: SERVER_INFO.HTTP, via, httpStatus: status, text };
  }

  const htmlHint = detectHtmlLoginHint(text);
  if (htmlHint) {
    if (!isCredentialHint(htmlHint)) {
      // eslint-disable-next-line no-console
      console.warn('[login] server page (non-credential)', server.baseUrl, status, '=>', htmlHint, '->', text.slice(0, 140));
    }
    return { ok: false, status: htmlHint, via, httpStatus: status };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[login] unparseable body', server.baseUrl, status, '->', text.slice(0, 140));
    return { ok: false, status: SERVER_INFO.PARSE, via, httpStatus: status };
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return { ok: false, status: SERVER_INFO.PARSE, via, httpStatus: status };
  }

  const info = parsed.user_info;
  if (!info) {
    return { ok: false, status: SERVER_INFO.PARSE, via, httpStatus: status };
  }

  const auth = String(info.auth ?? '');
  const isAuthOk = auth === '1';
  if (!isAuthOk) {
    const problem = accountProblem(info);
    if (problem) return { ok: false, ...problem };
    return { ok: false, status: SERVER_INFO.INVALID, info, via, httpStatus: status };
  }

  // Persist the working session. Use the URL that actually succeeded (may be
  // HTTPS vs the http alias) so subsequent stream URLs are not mixed-content.
  const effBase = effectiveBaseUrl(resUrl) || server.baseUrl;
  const session = { baseUrl: effBase, username: server.username, password: server.password };
  saveSession({ ...session, user_info: info });
  return {
    ok: true,
    status: SERVER_INFO.INVALID,
    info,
    serverInfo: parsed.server_info,
    session,
    effectiveBaseUrl: effBase,
    via,
    httpStatus: status,
  };
}

// True when an HTML login hint is a genuine credential verdict (vs an infra
// page like "403 Forbidden" / nginx / captcha that is NOT about credentials).
function isCredentialHint(hint) {
  return hint === SERVER_INFO.INVALID || hint === SERVER_INFO.EXPIRED;
}

// Classify why a non-auth OK response means the account is unusable. Mirrors
// Roku loginAccountProblem / loginDetectXuiHint.
export function accountProblem(info) {
  if (!info) return null;
  const statusText = String(info.status || '').toLowerCase();
  const isTrial = String(info.is_trial || '') === '1';

  let expired = statusText === 'expired' || statusText === 'expire' || statusText === 'inactive';
  const expRaw = String(info.exp_date || '');
  if (!expired && expRaw && expRaw !== '0' && expRaw.toLowerCase() !== 'null') {
    const exp = Number(expRaw);
    if (Number.isFinite(exp) && exp > 0 && exp < Date.now() / 1000) expired = true;
  }

  if (isTrial && expired) return { status: SERVER_INFO.EXPIRED, trial: true };
  if (expired) return { status: SERVER_INFO.EXPIRED };
  if (statusText === 'banned') return { status: SERVER_INFO.BANNED };
  if (statusText === 'disabled') return { status: SERVER_INFO.DISABLED };
  return null;
}

// Restore a saved session by validating it against the panel. Called on
// relaunch; if the saved server rejects, the caller falls back to login.
export async function tryRestoreSession() {
  const saved = getSession();
  if (!saved || !saved.baseUrl || !saved.username || !saved.password) return null;
  const result = await login({
    baseUrl: saved.baseUrl,
    username: saved.username,
    password: saved.password,
  });
  if (result.ok) return { ...result, restored: true };
  return result;
}

export function logout() {
  clearSession();
}

// --- Categories ---------------------------------------------

export async function getLiveCategories(server) {
  return apiList(server, 'get_live_categories');
}

export async function getVodCategories(server) {
  return apiList(server, 'get_vod_categories');
}

export async function getSeriesCategories(server) {
  return apiList(server, 'get_series_categories');
}

// --- Streams ------------------------------------------------

export async function getLiveStreams(server, categoryId) {
  return apiList(server, 'get_live_streams', categoryId ? { category_id: categoryId } : {});
}

export async function getVodStreams(server, categoryId) {
  return apiList(server, 'get_vod_streams', categoryId ? { category_id: categoryId } : {});
}

export async function getSeries(server, categoryId) {
  return apiList(server, 'get_series', categoryId ? { category_id: categoryId } : {});
}

// --- Details -------------------------------------------------

export async function getSeriesInfo(server, seriesId) {
  return apiCall(server, 'get_series_info', { series_id: seriesId });
}

export async function getVodInfo(server, vodId) {
  return apiCall(server, 'get_vod_info', { vod_id: vodId });
}

export async function getShortEpg(server, streamId, limit = 12) {
  return apiList(server, 'get_short_epg', { stream_id: streamId, limit });
}

// --- Generic helpers ------------------------------------------

async function apiCall(server, action, params = {}) {
  const { baseUrl, username, password } = server;
  const key = cacheKey(action, { ...params, username, password });
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const url = buildPlayerApiUrl(baseUrl, username, password, action, params);
  let text;
  try {
    const res = await corsFetch(url, { userAgent: 'IPTVSmartersPlayer' });
    text = res.text;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[api] network error', action, String(err?.message || err));
    return { error: SERVER_INFO.NETWORK };
  }
  const htmlHint = detectHtmlLoginHint(text);
  if (htmlHint) return { error: htmlHint };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[api] unparseable body', action, '->', text.slice(0, 140));
    return { error: SERVER_INFO.PARSE };
  }
  cacheSet(key, parsed);
  return parsed;
}

async function apiList(server, action, params = {}) {
  const result = await apiCall(server, action, params);
  if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) {
    return [];
  }
  return parseXtreamList(result);
}

// --- Playback URLs (never cached) ----------------------------

export function liveStreamUrl(server, streamId) {
  return `${normalizeBaseUrl(server.baseUrl)}/live/${server.username}/${server.password}/${streamId}.m3u8`;
}

export function vodStreamUrl(server, vodId, extension) {
  return `${normalizeBaseUrl(server.baseUrl)}/movie/${server.username}/${server.password}/${vodId}.${
    extension || 'mp4'
  }`;
}

export function seriesStreamUrl(server, containerExt, episode, season, seriesId) {
  // Xtream series direct URL: /series/U/P/EpisodeID.extension
  const id = episode ? episode.id : seriesId;
  return `${normalizeBaseUrl(server.baseUrl)}/series/${server.username}/${server.password}/${id}.${
    containerExt || 'mp4'
  }`;
}
