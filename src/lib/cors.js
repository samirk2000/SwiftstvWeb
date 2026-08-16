// CORS-safe request helper.
//
// The Xtream panels and the Exclusivos proxy do not send CORS headers, so a
// static browser page cannot fetch them directly. In production (Cloudflare
// Pages) we route those fetches through the `functions/proxy.js` Pages
// Function; in dev the SAME `/proxy` prefix is handled by Vite's
// `server.proxy` (see vite.config.js), so both environments share one code path.
//
// Only metadata / JSON requests go through the proxy. Video streams
// (`.m3u8` / `.mp4`) are served straight to HLS.js / <video> and do NOT use
// this helper (browsers play media without CORS for the media element; and the
// Exclusivos proxy 302s to a CDN that must be followed natively).

const SDK =
  (globalThis.location && location.origin) ||
  `http://localhost:${import.meta.env.VITE_PORT || 5173}`;

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

/** GET through the CORS proxy (text). Returns '' on non-2xx / failure. */
export async function proxiedGet(targetUrl, opts = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(proxyUrl(targetUrl, opts));
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (err) {
    return { status: 0, ok: false, text: '', error: err };
  }
}

// Github.githubusercontent / jsdelivr send `Access-Control-Allow-Origin: *`, so
// no proxy is needed for public GitHub artifacts. Try direct first; if the
// panel blocks us, fall back to the proxy.
export async function corsFetch(targetUrl, opts = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(targetUrl, {
      headers: { 'User-Agent': opts.userAgent || 'IPTVSmartersPlayer', Accept: '*/*' },
    });
    if (res.ok) return { ok: true, status: res.status, text: await res.text() };
    // Non-2xx (e.g. 403 from a CORS/WAF rule) → fall back to proxy.
    return proxiedGet(targetUrl, opts, fetchImpl);
  } catch {
    // Network / CORS block → proxy.
    return proxiedGet(targetUrl, opts, fetchImpl);
  }
}

export const isDevOrUndefined = typeof SDK === 'string';
