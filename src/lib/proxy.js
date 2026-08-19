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
  if (single) return [single];
  // Build-time fallback so production catches the Xtream 302→CDN redirect
  // through one of OUR proxies instead of falling to the Cloudflare `/proxy`
  // (which the panels/CDNs 403). These are PUBLIC stream endpoints (no
  // credentials) — override per-deploy via VITE_STREAM_PROXY_URLS.
  return ['https://proxy.swiftstv.com/stream', 'https://swiftstv-web.vercel.app/api/stream-proxy'];
})();

// Backwards-compatible single URL (first configured external proxy).
export const STREAM_PROXY_URL = STREAM_PROXY_URLS[0] || '';

// True when at least one external proxy is configured.
export function hasStreamProxy() {
  return STREAM_PROXY_URLS.length > 0;
}

// How many different routes we try for a media URL before giving up.
// Ordered by "most likely to work from an HTTPS page":
//   1) The VPS /stream proxy first, then any other external proxy (Deno/Vercel)
//      — a panel may 403 one cloud's ranges but not another's, so try them all.
//   2) Direct (some TVs / panels serve https manifests without a redirect).
//   3) Cloudflare Pages Function (last resort — often 403'd by panels).
export function streamProxyCandidates(mediaUrl, opts = {}) {
  const continuous = Boolean(opts && opts.continuous);
  // LIVE HLS FALLBACK is a strictly MONO-CONNECTION route. Instead of handing
  // back a fat list of proxy candidates (each of which hls.js will poke with
  // fragment retries and manifest reloads), we return only the SINGLE most
  // reliable route — the VPS /stream proxy. The panel/CDN counts every socket
  // as a separate connection, and probing several proxies at once on a slow
  // live channel is what made the panel show multiple connections and flood
  // the network tab. The few channels that genuinely need the fallback can
  // keep the one route stable; if it hard-fails the caller still surfaces a
  // Retry (never an automatic multi-proxy loop on live).
  const singleLiveRoute = Boolean(opts && opts.liveFallback);
  const origin = globalThis.location ? globalThis.location.origin : 'https://swiftstvweb.pages.dev';
  const target = new URL(mediaUrl, origin).toString();

  // If the URL is ALREADY routed through one of our proxies (a rewritten segment
  // from the VPS manifest or a previous cache-buster retry), don't re-wrap it —
  // just return it as the single candidate so it keeps hitting the SAME host
  // (which injects the IPTV player UA) instead of being bounced back to /proxy.
  if (/\/stream\?target=|stream-proxy\?target=|\?target=/.test(target) || target.startsWith('/proxy?')) {
    // Continuous live must always keep continuous=1, even if the URL was already
    // proxied (e.g. a reload/retry) — otherwise it would silently drop to the
    // old segmented /stream behavior and break the single-connection guarantee.
    if (continuous && !/continuous=1|continuous=true/.test(target)) {
      const sep = String(target).includes('?') ? '&' : '?';
      return dedupe([`${target}${sep}continuous=1`]);
    }
    return dedupe([target]);
  }

  // For continuous live .ts, tell the VPS proxy (and any stream-proxy) to serve
  // it as ONE endless MPEG-TS shared across viewers instead of HLS segments.
  // In continuous mode the live channel MUST go through a proxy that implements
  // the fan-out (continuous=1) — we do NOT fall back to a raw direct URL or to
  // the Cloudflare /proxy function (which aren't the continuous passthrough).
  const flags = continuous ? '&continuous=1' : '';
  const enc = encodeURIComponent(target);
  const candidates = [];
  // Prefer the VPS /stream proxy (Hetzner, injects User-Agent IPTVSmartersPlayer
  // and follows the panel 302→CDN) whenever it's configured, so VOD/MP4 never
  // silently drops to the Cloudflare /proxy function (which the panels/CDNs 403).
  const vps = STREAM_PROXY_URLS.find((u) => /\/stream($|[?#])/i.test(u.replace(/\/+$/, '')));
  const rest = STREAM_PROXY_URLS.filter((u) => u !== vps);
  // Live HLS fallback: commit to the VPS /stream proxy alone and stop. We do
  // NOT append the raw URL / CF-function / second proxy — a live .m3u8 that
  // stalls on one route just needs a bounded Retry, not four concurrent
  // probes that keep 3 connections alive on the panel.
  if (singleLiveRoute) {
    if (!vps) candidates.push(mediaUrl);
    else {
      let b = vps.replace(/\/+$/, '').trim();
      if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
      else if (b.startsWith('http://')) b = `https://${b.slice('http://'.length)}`;
      candidates.push(`${b}?target=${enc}`);
    }
    return dedupe(candidates);
  }
  for (const base of [vps, ...rest]) {
    if (!base) continue;
    // Some envs end up with "proxy.domain" (no scheme) or "http://..." — we run
    // on an HTTPS page so force the proxy to https to avoid mixed-content on the
    // outer manifest URL (and because these proxies sit behind TLS).
    let b = base.replace(/\/+$/, '').trim();
    if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
    else if (b.startsWith('http://')) b = `https://${b.slice('http://'.length)}`;
    candidates.push(`${b}?target=${enc}${flags}`);
  }
  if (continuous) {
    // Live: only the continuous-passthrough proxies are valid candidates. If
    // none is configured, keep the raw URL so the list is non-empty, but never
    // add the generic direct/CF fallbacks (they'd skip the continuous flag).
    if (!candidates.length) candidates.push(mediaUrl);
    return dedupe(candidates);
  }
  if (!candidates.length) candidates.push(mediaUrl);
  candidates.push(mediaUrl, `/proxy?target=${enc}${flags}`);
  return dedupe(candidates);
}

// Drop duplicate candidate URLs (e.g. the same proxy listed twice), preserving order.
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}
