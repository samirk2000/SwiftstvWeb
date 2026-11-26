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
import { beginForeground, kindForAction } from './netActivity.js';
import { cleanTitle, decodeBase64Utf8 } from './text.js';

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
    const res = await corsFetch(url, {
      userAgent: 'IPTVSmartersPlayer',
      forceProxy: server.via === 'proxy',
      timeoutMs: server.timeoutMs || 20000,
    });
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
    if (problem) return { ok: false, ...problem, info };
    return { ok: false, status: SERVER_INFO.INVALID, info, via, httpStatus: status };
  }

  // Persist the working session. Use the URL that actually succeeded (may be
  // HTTPS vs the http alias) so subsequent stream URLs are not mixed-content.
  const effBase = effectiveBaseUrl(resUrl) || server.baseUrl;
  const session = { baseUrl: effBase, username: server.username, password: server.password };
  // During the parallel failover race the caller saves only the winner.
  if (!server.noSave) saveSession({ ...session, user_info: info });
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

export async function getLiveCategories(server, opts) {
  return apiList(server, 'get_live_categories', {}, opts);
}

export async function getVodCategories(server, opts) {
  return apiList(server, 'get_vod_categories', {}, opts);
}

export async function getSeriesCategories(server, opts) {
  return apiList(server, 'get_series_categories', {}, opts);
}

// --- Streams ------------------------------------------------

export async function getLiveStreams(server, categoryId, opts) {
  return apiList(server, 'get_live_streams', categoryId ? { category_id: categoryId } : {}, opts);
}

export async function getVodStreams(server, categoryId, opts) {
  return apiList(server, 'get_vod_streams', categoryId ? { category_id: categoryId } : {}, opts);
}

export async function getSeries(server, categoryId, opts) {
  return apiList(server, 'get_series', categoryId ? { category_id: categoryId } : {}, opts);
}

// --- Details -------------------------------------------------

export async function getSeriesInfo(server, seriesId) {
  return apiCall(server, 'get_series_info', { series_id: seriesId });
}

export async function getVodInfo(server, vodId) {
  return apiCall(server, 'get_vod_info', { vod_id: vodId });
}

// Xtream short_epg rows carry `start`/`end` as "YYYY-MM-DD HH:MM:SS" strings
// (panel time zone) plus `start_timestamp`/`stop_timestamp` in epoch seconds,
// and base64-encoded `title`/`description`. The UI works in epoch seconds and
// plain text, so normalise here (this is why the guide always looked empty).
export function normalizeEpgRow(e) {
  if (!e || typeof e !== 'object') return null;
  const toEpoch = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 1e9 ? n : 0;
  };
  const start = toEpoch(e.start_timestamp) || toEpoch(e.start);
  const stop = toEpoch(e.stop_timestamp) || toEpoch(e.end_timestamp) || toEpoch(e.stop) || toEpoch(e.end);
  if (!start) return null;
  return {
    ...e,
    start,
    stop: stop || start + 3600,
    title: cleanTitle(decodeBase64Utf8(e.title)),
    description: cleanTitle(decodeBase64Utf8(e.description)),
  };
}

export async function getShortEpg(server, streamId, limit = 12) {
  const rows = await apiList(server, 'get_short_epg', { stream_id: streamId, limit }, { timeoutMs: 15000 });
  return rows
    .map(normalizeEpgRow)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

// --- Generic helpers ------------------------------------------

async function apiCall(server, action, params = {}, opts = {}) {
  const { baseUrl, username, password } = server;
  const key = cacheKey(action, { ...params, username, password });
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const url = buildPlayerApiUrl(baseUrl, username, password, action, params);
  let text;
  // Foreground requests (the user is waiting) are tracked so the UI can show
  // download progress and the background search index yields to them.
  const activity = opts.background ? null : beginForeground(kindForAction(action));
  try {
    const res = await corsFetch(url, {
      userAgent: 'IPTVSmartersPlayer',
      timeoutMs: opts.timeoutMs || 30000,
      onProgress: activity ? activity.progress : undefined,
    });
    text = res.text;
    if (!res.ok && !text) return { error: SERVER_INFO.NETWORK };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[api] network error', action, String(err?.message || err));
    return { error: SERVER_INFO.NETWORK };
  } finally {
    if (activity) activity.end();
  }
  const htmlHint = detectHtmlLoginHint(text);
  if (htmlHint) return { error: htmlHint };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[api] unparseable body', action, '->', String(text || '').slice(0, 140));
    return { error: SERVER_INFO.PARSE };
  }
  // Huge full-catalog lists (30 MB of VOD) must not sit in this Map on a TV.
  if (!opts.noCache) cacheSet(key, parsed);
  return parsed;
}

// Clean names for TV fonts and drop duplicate rows (the same stream is listed
// once per category it belongs to when the full list is requested).
// Movies/series uploaded twice to the panel (same title + format, different
// stream_id) are also collapsed — channels are NOT, since two feeds with the
// same name are usually main/backup signals.
function tidyList(list, byName = false) {
  const out = [];
  const seen = new Set();
  const seenNames = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const id = row.stream_id ?? row.series_id ?? null;
    if (id !== null && id !== undefined && id !== '') {
      const k = String(id);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    if (byName && typeof row.name === 'string' && row.name) {
      const nk = `${row.name.trim().toLowerCase()}|${String(row.container_extension || '').toLowerCase()}|${row.category_id ?? ''}`;
      if (seenNames.has(nk)) continue;
      seenNames.add(nk);
    }
    if (typeof row.name === 'string' && !row._clean) {
      row.name = cleanTitle(row.name);
    }
    if (typeof row.category_name === 'string' && !row._clean) {
      row.category_name = cleanTitle(row.category_name);
    }
    row._clean = true;
    out.push(row);
  }
  return out;
}

async function apiList(server, action, params = {}, opts = {}) {
  const result = await apiCall(server, action, params, opts);
  if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) {
    if (opts.throwOnError) throw new Error(String(result.error));
    return [];
  }
  const list = parseXtreamList(result);
  if (action === 'get_short_epg') return list;
  return tidyList(list, action === 'get_vod_streams' || action === 'get_series');
}

// --- Playback URLs (never cached) ----------------------------

export function liveStreamUrl(server, streamId) {
  return `${normalizeBaseUrl(server.baseUrl)}/live/${server.username}/${server.password}/${streamId}.m3u8`;
}

// Continuous live MPEG-TS URL for LIVE playback. Xtream panels serve endless
// MPEG-TS at /live/U/P/ID.ts (not fragmented HLS), letting the proxy keep ONE
// persistent connection to the panel and stream it straight to the player
// (mpegts.js). Used instead of the .m3u8 route for live viewing.
export function liveStreamTsUrl(server, streamId) {
  return `${normalizeBaseUrl(server.baseUrl)}/live/${server.username}/${server.password}/${streamId}.ts`;
}

// Catchup URL for a live stream with archive enabled. Xtream panels serve the
// archive on the SAME /live/ route with `start`/`end` unix-epoch param (UTC)
// delimiting the programme window; without them it's the live edge. Some
// panels prefer `.ts` (archive) over `.m3u8`. The player seeks `startPosition`
// (seconds into the window) once metadata loads.
export function liveCatchupUrl(server, streamId, { startEpoch, endEpoch, ts = false } = {}) {
  const base = `${normalizeBaseUrl(server.baseUrl)}/live/${server.username}/${server.password}/${streamId}.${
    ts ? 'ts' : 'm3u8'
  }`;
  if (!startEpoch) return base;
  const qs = new URLSearchParams();
  qs.set('start', startEpoch);
  if (endEpoch) qs.set('end', endEpoch);
  return `${base}?${qs.toString()}`;
}

// VOD/series panels sometimes report a `container_extension` that makes the
// panel transmux/encode a live-ish session instead of serving the stored file
// — "ts"/"m3u8"/"m3u" on a movie entry causes the slow start and constant
// session resets the user sees, and TV browsers can't decode raw TS either.
// The stored file is served as-is regardless of the extension in the URL, so
// map those triggers to `.mp4` (natively playable). Mirrors Android
// `XtreamUrls.normalizeExt` plus the ts→mp4 rule.
const TRANSMUX_EXTENSIONS = ['ts', 'm3u8', 'm3u', 'm3u9'];
export function vodPlayableExtension(ext) {
  const e = String(ext || '').trim().toLowerCase().replace(/^\./, '');
  if (!e || TRANSMUX_EXTENSIONS.includes(e)) return 'mp4';
  return e;
}

export function vodStreamUrl(server, vodId, extension) {
  return `${normalizeBaseUrl(server.baseUrl)}/movie/${server.username}/${server.password}/${vodId}.${vodPlayableExtension(
    extension
  )}`;
}

export function seriesStreamUrl(server, containerExt, episode, season, seriesId) {
  // Xtream series direct URL: /series/U/P/EpisodeID.extension
  const id = episode ? episode.id : seriesId;
  return `${normalizeBaseUrl(server.baseUrl)}/series/${server.username}/${server.password}/${id}.${vodPlayableExtension(
    containerExt
  )}`;
}
