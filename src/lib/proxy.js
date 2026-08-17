// External stream proxy configuration (optional but recommended).
//
// The Xtream panels 302 their live/VOD/series manifests to an `http://` CDN IP
// (mixed-content block on our HTTPS page), 403 Cloudflare's ranges, and serve an
// invalid TLS cert on that CDN — so neither the browser nor the Pages Function
// can play the stream directly. An OUTSIDE proxy (Deno Deploy / Vercel) that
// follows the redirects and re-proxies the whole stream is the working route.
//
// Configure at build time, e.g.:
//   Deno Deploy  -> https://<project>.deno.dev
//   Vercel       -> https://<project>.vercel.app/api/stream-proxy
// Run:  `VITE_STREAM_PROXY_URL=https://... npm run build`
// If unset, the player skips the external route and falls back to direct/CF.
export const STREAM_PROXY_URL =
  (import.meta.env && import.meta.env.VITE_STREAM_PROXY_URL) ||
  '';

// True when no external proxy is configured (placeholder URL above or empty).
export function hasStreamProxy() {
  return Boolean(STREAM_PROXY_URL);
}

// How many different routes we try for a media URL before giving up.
// Ordered by "most likely to work from an HTTPS page":
//   1) External stream proxy (Deno/Vercel) — only if configured.
//   2) Direct (some TVs / panels serve https manifests without a redirect).
//   3) Cloudflare Pages Function (last resort — often 403'd by panels).
export function streamProxyCandidates(mediaUrl) {
  const origin = globalThis.location ? globalThis.location.origin : 'https://swiftstvweb.pages.dev';
  const target = new URL(mediaUrl, origin).toString();
  const enc = encodeURIComponent(target);
  const candidates = [];
  if (hasStreamProxy()) {
    // Append ?target= directly (no forced "/") so Vercel's exact route
    // `/api/stream-proxy` matches; Deno Deploy serves query on the root fine.
    const base = STREAM_PROXY_URL.replace(/\/+$/, '');
    candidates.push(`${base}?target=${enc}`);
  }
  candidates.push(mediaUrl, `/proxy?target=${enc}`);
  return candidates;
}
