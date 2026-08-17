// External stream proxy configuration (optional but recommended).
//
// The Xtream panels 302 their live/VOD/series manifests to an `http://` CDN IP
// (mixed-content block on our HTTPS page), 403 Cloudflare's ranges, and serve an
// invalid TLS cert on that CDN — so neither the browser nor the Pages Function
// can play the stream directly. An OUTSIDE proxy (Deno Deploy / Vercel) that
// follows the redirects and re-proxies the whole stream is the working route.
//
// DIFFERENT panels/CDNs block DIFFERENT cloud ranges (we've seen 403s to
// Cloudflare AND to AWS). So we support MULTIPLE outside proxies and try them in
// order until one serves the stream. Configure at build time with either:
//   VITE_STREAM_PROXY_URLS=https://<deno>.deno.dev,https://<vercel>.vercel.app/api/stream-proxy
// (comma-separated); or keep the single VITE_STREAM_PROXY_URL for one.
// Run:  `VITE_STREAM_PROXY_URLS="..." npm run build`
// If unset, the player skips the external route and falls back to direct/CF.
function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const STREAM_PROXY_URLS = (() => {
  if (import.meta.env && import.meta.env.VITE_STREAM_PROXY_URLS) {
    return splitList(import.meta.env.VITE_STREAM_PROXY_URLS);
  }
  const single = (import.meta.env && import.meta.env.VITE_STREAM_PROXY_URL) || '';
  return single ? [single] : [];
})();

// Backwards-compatible single URL (first configured external proxy).
export const STREAM_PROXY_URL = STREAM_PROXY_URLS[0] || '';

// True when at least one external proxy is configured.
export function hasStreamProxy() {
  return STREAM_PROXY_URLS.length > 0;
}

// How many different routes we try for a media URL before giving up.
// Ordered by "most likely to work from an HTTPS page":
//   1) Each external stream proxy (Deno/Vercel), in configured order — a panel
//      may 403 one cloud's ranges but not another's, so try them all.
//   2) Direct (some TVs / panels serve https manifests without a redirect).
//   3) Cloudflare Pages Function (last resort — often 403'd by panels).
export function streamProxyCandidates(mediaUrl) {
  const origin = globalThis.location ? globalThis.location.origin : 'https://swiftstvweb.pages.dev';
  const target = new URL(mediaUrl, origin).toString();
  const enc = encodeURIComponent(target);
  const candidates = [];
  for (const base of STREAM_PROXY_URLS) {
    const b = base.replace(/\/+$/, '');
    candidates.push(`${b}?target=${enc}`);
  }
  if (!candidates.length) candidates.push(mediaUrl);
  candidates.push(mediaUrl, `/proxy?target=${enc}`);
  return candidates;
}
