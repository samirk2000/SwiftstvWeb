// CORS-safe request helper.
//
// The Xtream panels and the Exclusivos proxy often do not send CORS headers, so
// a static browser page has traditionally needed a server-side proxy. In
// production (Cloudflare Pages) we can route through the `functions/proxy.js`
// Pages Function; in dev the SAME `/proxy` prefix is handled by a Vite
// middleware (see vite.config.js) so both environments share one code path.
//
// IMPORTANT (login diagnosis): panels frequently block Cloudflare/edge IPs with
// a 403 nginx page, so the proxy is NOT always viable. Better strategy, applied
// here in `corsFetch`:
//   1) Try DIRECT first, preferring HTTPS -> HTTP (avoids mixed-content from an
//      HTTPS origin; panels like cvcplayer.us serve both and emit the
//      Access-Control-Allow-Origin header for the site's origin).
//   2) If the direct call is blocked by real CORS / mixed-content, fall back to
//      the proxy.
// Only metadata / JSON requests go through this helper. Video streams (`.m3u8`
// `.ts`/`.mp4`) are (since the "HTTP-only CDN" fix) routed through `/proxy` by
// `lib/player.js#proxyMediaUrl` — Xtream live unlocks their hosts via an
// `http://IP` redirect that an HTTPS page would block — while Exclusivos media
// uses its own dynamic proxy + Referer/Origin headers.

const SDK =
  (globalThis.location && location.origin) ||
  `http://localhost:${import.meta.env.VITE_PORT || 5173}`;

// Runtime flag so we can keep logs compact in production.
const DEBUG = /[?&]debug=1/.test(globalThis.location ? globalThis.location.search : '');

function dbg(label, ...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[cors]`, label, ...args);
}

/**
 * Rewrite an http:// URL to https:// on the same host.
 *
 * Panels serve plain text HTTP on a non-standard port (8080) and TLS on the
 * default HTTPS port (443). So when converting an incoming http://host:8080 to
 * HTTPS we MUST use 443 — otherwise we get https://host:8080 which browsers
 * treat as mixed-content / CORS-unreadable. If the URL is already https we keep
 * its explicit port (a panel could run TLS on a custom port).
 */
export function preferHttps(url) {
  const u = new URL(url);
  if (u.protocol === 'http:') {
    u.protocol = 'https:';
    u.port = ''; // default https port 443 (drops :8080 / :80)
  }
  return u.toString();
}

/**
 * Build a same-origin proxied URL for an absolute target.
 * @param {string} targetUrl absolute http(s) URL to fetch server-side
 * @param {{ userAgent?: string, referer?: string, origin?: string }} [opts]
 */
export function proxyUrl(targetUrl, opts = {}) {
  const u = new URL('/proxy', SDK);
  u.searchParams.set('target', targetUrl);
  if (opts.userAgent) u.searchParams.set('ua', opts.userAgent);
  if (opts.referer) u.searchParams.set('referer', opts.referer);
  if (opts.origin) u.searchParams.set('origin', opts.origin);
  return u.toString();
}

/** GET through the CORS proxy (text). Returns {ok,status,text}. */
export async function proxiedGet(targetUrl, opts = {}, fetchImpl = fetch, signal) {
  try {
    const res = await fetchImpl(proxyUrl(targetUrl, opts), { signal });
    const text = await res.text();
    dbg('proxy', targetUrl, '->', res.status, snippet(text));
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    dbg('proxy', targetUrl, 'ERR', String(err?.message || err));
    return { status: 0, ok: false, text: '', error: err };
  }
}

function snippet(text, n = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Try fetch against each candidate URL (https then http) directly. Returns the
// first 2xx response, or the last response when all fail. Throws only if even
// the fallback fetch throws (e.g. mixed content).
//
// CRITICAL: do NOT set `User-Agent` in the headers here. A `User-Agent` set via
// fetch() is not CORS-safelisted, so the browser sends a preflight (OPTIONS)
// that panels/GitHub reject -> "CORS header missing" even though the direct GET
// itself returns 200. The browser sends its own UA by default.
async function tryDirect(urls, opts, fetchImpl) {
  let last = null;
  for (const u of urls) {
    try {
      const res = await fetchImpl(u, { headers: { Accept: '*/*' } });
      dbg('direct', u, '->', res.status);
      if (res.ok) return res;
      last = res; // 3xx/4xx — remember but keep trying https->http
    } catch (err) {
      dbg('direct', u, 'ERR', String(err?.message || err));
    }
  }
  if (last) return last;
  throw new Error('direct fetch failed for all candidates');
}

/**
 * Fetch a URL, returning { ok, status, text, via }.
 *  - `via: 'direct'`  — served straight (HTTPS preferred, HTTP fallback).
 *  - `via: 'proxy'`   — routed through /proxy (edge IP; may be blocked by WAF).
 *  - `opts.forceProxy` — skip direct entirely and always use /proxy. Useful
 *    when direct mixed-content/CORS is unreliable (the primary path in the
 *    deployed TV app); the `loginWithFailover` probe uses this to rank hosts.
 * Logs each attempt so login failures are diagnosable from the console.
 */
export async function corsFetch(targetUrl, opts = {}, fetchImpl = fetch, signal) {
  // Proxy-first path: the deployed TV app can't trust mixed-content/CORS from
  // the browser, and panels block Cloudflare IPs with 403 — so a host is
  // ranked by whether /proxy reaches it. Direct is only tried on demand.
  if (opts.forceProxy) {
    const p = await proxiedGet(targetUrl, opts, fetchImpl, signal);
    return { ...p, via: 'proxy', forced: true };
  }

  // HTTPS-first to dodge mixed-content; HTTP fallback covers http-only panels.
  const candidates = [];
  try {
    const u = new URL(targetUrl);
    if (u.protocol === 'https:') {
      candidates.push(u.toString());
    } else {
      candidates.push(preferHttps(u.toString()));
      candidates.push(u.toString());
    }
  } catch {
    candidates.push(targetUrl);
  }

  let direct;
  let directUrl = '';
  try {
    direct = await tryDirect(candidates, opts, fetchImpl);
    if (direct && direct.url) directUrl = direct.url;
  } catch {
    direct = { status: 0, ok: false };
  }

  if (direct && direct.ok) {
    return { ok: true, status: direct.status, text: await direct.text(), via: 'direct', url: directUrl || candidates[0] };
  }

  dbg('direct failed, falling back to proxy', targetUrl);
  const p = await proxiedGet(targetUrl, opts, fetchImpl, signal);
  return { ...p, via: 'proxy' };
}

export const isDevOrUndefined = typeof SDK === 'string';
