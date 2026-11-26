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

import { STREAM_PROXY_URLS } from './proxy.js';
import { httpVariant, isChallengePage, markHttpRelay, prefersHttpRelay } from './relayHosts.js';

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

/**
 * Read a response body as text, reporting download progress when asked.
 * `total` is Content-Length when the server exposes it (0 = unknown; if the
 * body turns out larger — gzip — the total is dropped and only bytes count).
 */
export async function readText(res, onProgress) {
  if (typeof onProgress !== 'function' || !res.body || typeof res.body.getReader !== 'function') {
    return res.text();
  }
  let total = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let loaded = 0;
  let out = '';
  let lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (total && loaded > total) total = 0;
    const now = Date.now();
    if (now - lastTick > 250) {
      lastTick = now;
      try {
        onProgress(loaded, total);
      } catch {
        /* ignore */
      }
    }
  }
  out += decoder.decode();
  return out;
}

/** GET through the CORS proxy (text). Returns {ok,status,text}. */
export async function proxiedGet(targetUrl, opts = {}, fetchImpl = fetch, signal) {
  try {
    const res = await fetchImpl(proxyUrl(targetUrl, opts), { signal });
    const text = await readText(res, opts.onProgress);
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
async function tryDirect(urls, opts, fetchImpl, signal) {
  let last = null;
  for (const u of urls) {
    if (signal && signal.aborted) break;
    try {
      const res = await fetchImpl(u, { headers: { Accept: '*/*' }, signal });
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
// Per-host memory of the route that last worked ('direct' | 'vps' | 'proxy').
// Panels behind Cloudflare 403 datacenter IPs (our /proxy) but accept the
// Hetzner VPS, and some only answer direct over HTTPS — remembering the winner
// avoids paying 1-3 failed round-trips on every catalog request.
const hostRoute = new Map();

function hostKey(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** First configured VPS-style /stream proxy (Hetzner), if any. */
function vpsBase() {
  const vps = STREAM_PROXY_URLS.find((u) => /\/stream($|[?#])/i.test(String(u).replace(/\/+$/, '')));
  if (!vps) return '';
  let b = String(vps).replace(/\/+$/, '').trim();
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  return b;
}

/** GET through the Hetzner VPS /stream proxy (reaches panels that 403 Cloudflare). */
export async function vpsGet(targetUrl, fetchImpl = fetch, signal, onProgress) {
  const base = vpsBase();
  if (!base) return { status: 0, ok: false, text: '' };
  try {
    const res = await fetchImpl(`${base}?target=${encodeURIComponent(targetUrl)}`, { signal });
    const text = await readText(res, res.ok ? onProgress : undefined);
    dbg('vps', targetUrl, '->', res.status, snippet(text));
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    dbg('vps', targetUrl, 'ERR', String(err?.message || err));
    return { status: 0, ok: false, text: '', error: err };
  }
}

// Combine an optional caller signal with a timeout.
function withTimeout(signal, ms) {
  if (!ms || typeof AbortController === 'undefined') return { signal, done: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Fetch a URL, returning { ok, status, text, via, url }.
 *  - `via: 'direct'` — served straight (HTTPS preferred; HTTP only on an http page).
 *  - `via: 'vps'`    — through the Hetzner /stream proxy (works for panels that
 *                      block Cloudflare / datacenter ranges).
 *  - `via: 'proxy'`  — through the Cloudflare Pages /proxy function (last resort).
 *  - `opts.forceProxy` — only the Cloudflare /proxy.
 *  - `opts.timeoutMs`  — abort the whole chain after N ms (default 30s).
 * The route that works is remembered per host so later calls go straight to it.
 */
export async function corsFetch(targetUrl, opts = {}, fetchImpl = fetch, signal) {
  if (opts.forceProxy) {
    const p = await proxiedGet(targetUrl, opts, fetchImpl, signal);
    return { ...p, via: 'proxy', forced: true };
  }

  const { signal: sig, done } = withTimeout(signal, opts.timeoutMs === 0 ? 0 : opts.timeoutMs || 30000);
  try {
    const host = hostKey(targetUrl);
    const remembered = hostRoute.get(host);

    // HTTPS-first to dodge mixed-content. Plain http is only worth trying when
    // the page itself is http (dev server); on https it is always blocked.
    const candidates = [];
    try {
      const u = new URL(targetUrl);
      if (u.protocol === 'https:') {
        candidates.push(u.toString());
      } else {
        candidates.push(preferHttps(u.toString()));
        const pageIsHttp = globalThis.location && globalThis.location.protocol === 'http:';
        if (pageIsHttp) candidates.push(u.toString());
      }
    } catch {
      candidates.push(targetUrl);
    }

    const routes = remembered === 'vps'
      ? ['vps', 'direct', 'proxy']
      : remembered === 'proxy'
        ? ['proxy', 'direct', 'vps']
        : ['direct', 'vps', 'proxy'];

    let last = { status: 0, ok: false, text: '' };
    for (const route of routes) {
      if (sig && sig.aborted) break;
      if (route === 'direct') {
        try {
          const direct = await tryDirect(candidates, opts, fetchImpl, sig);
          if (direct && direct.ok) {
            const text = await readText(direct, opts.onProgress);
            hostRoute.set(host, 'direct');
            return { ok: true, status: direct.status, text, via: 'direct', url: direct.url || candidates[0] };
          }
          if (direct) last = { status: direct.status, ok: false, text: '', via: 'direct' };
        } catch {
          // CORS / mixed content / network — try the next route.
        }
      } else if (route === 'vps') {
        if (!vpsBase()) continue;
        // HTTPS behind a Cloudflare challenge (cavctv.xyz…): the relay gets a
        // 403 "Just a moment…" page, but the panel's plain-HTTP origin answers.
        // Known hosts go straight to http://; others fall back to it once.
        const alt = httpVariant(targetUrl);
        const order = alt && prefersHttpRelay(targetUrl) ? [alt, targetUrl] : [targetUrl];
        let done = false;
        for (let i = 0; i < order.length && !done; i += 1) {
          if (sig && sig.aborted) break;
          const v = await vpsGet(order[i], fetchImpl, sig, opts.onProgress);
          if (v.ok && !isChallengePage(v.status, v.text)) {
            hostRoute.set(host, 'vps');
            return { ...v, via: 'vps', url: targetUrl };
          }
          if (alt && order[i] === targetUrl && order.length === 1 && isChallengePage(v.status, v.text)) {
            const h = await vpsGet(alt, fetchImpl, sig, opts.onProgress);
            if (h.ok && !isChallengePage(h.status, h.text)) {
              markHttpRelay(targetUrl);
              hostRoute.set(host, 'vps');
              return { ...h, via: 'vps', url: targetUrl };
            }
            if (h.status) last = { ...h, via: 'vps' };
            done = true;
          } else if (v.status) last = { ...v, via: 'vps' };
        }
      } else {
        dbg('falling back to /proxy', targetUrl);
        const p = await proxiedGet(targetUrl, opts, fetchImpl, sig);
        if (p.ok) {
          hostRoute.set(host, 'proxy');
          return { ...p, via: 'proxy', url: targetUrl };
        }
        if (p.status) last = { ...p, via: 'proxy' };
      }
    }
    if (remembered) hostRoute.delete(host);
    return { ...last, ok: false, url: targetUrl };
  } finally {
    done();
  }
}

export const isDevOrUndefined = typeof SDK === 'string';
