/**
 * Vercel mirror of the stream proxy (full rationale in `stream-proxy/mod.ts`).
 * Deployed on Vercel (AWS) — NOT Cloudflare — because the Xtream panels and
 * their CDN IPs 403 Cloudflare's ranges and the CDN serves an invalid TLS cert.
 *
 * This proxy follows the panel's 302 to the http:// CDN and rewrites every
 * playlist URI to route back through itself, so the BROWSER only talks to the
 * proxy's valid HTTPS for both the manifest and the TS segments.
 *
 * Vercel setup: `vercel.json` routes `/api/stream-proxy` to this function with
 * `@vercel/node`. Uses the CLASSIC Node `(req, res)` signature, which is the
 * most reliable for Vercel Node Functions (avoids FUNCTION_INVOCATION_FAILED on
 * some plans).
 *
 * Usage: GET /api/stream-proxy?target=<encodeURIComponent(panel m3u8 URL)>
 */

// Vercel sets the deployment base URL; use it so rewritten segment URLs use the
// same host the browser is already on.
const ALLOW_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
  'cache-control': 'no-store',
};

export default async function handler(req, res) {
  // CORS preflight.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, ALLOW_CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const target = url.searchParams.get('target');
  // The browser may call an absolute selfBase (deployment URL) — Vercel rewrites
  // it to the function origin, so rebuild selfBase from the request host.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const selfBase = `${proto}://${req.headers.host || url.host}`;

  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...ALLOW_CORS });
    res.end(JSON.stringify({ error: 'missing "target"' }));
    return;
  }

  let t;
  try {
    t = new URL(target.trim());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...ALLOW_CORS });
    res.end(JSON.stringify({ error: 'bad target' }));
    return;
  }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'application/json', ...ALLOW_CORS });
    res.end(JSON.stringify({ error: 'bad target protocol' }));
    return;
  }

  const upstreamHeaders = {
    'User-Agent': 'IPTVSmartersPlayer',
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  const range = req.headers.range;
  if (range) upstreamHeaders.Range = range;

  try {
    const upstream = await fetch(t.toString(), { headers: upstreamHeaders, redirect: 'follow' });
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    const isPlaylist = /mpegurl|vnd\.apple/i.test(ct);

    let body;
    const outHeaders = { 'Content-Type': ct, ...ALLOW_CORS };
    if (isPlaylist) {
      const resolved = upstream.url;
      body = Buffer.from(await rewritePlaylist(await upstream.text(), resolved, selfBase));
    } else {
      body = Buffer.from(await upstream.arrayBuffer());
      const len = upstream.headers.get('content-length');
      if (len) outHeaders['Content-Length'] = len;
      if (range) {
        const cr = upstream.headers.get('content-range');
        if (cr) outHeaders['Content-Range'] = cr;
        const ar = upstream.headers.get('accept-ranges');
        if (ar) outHeaders['Accept-Ranges'] = ar;
      }
    }

    res.writeHead(upstream.status, outHeaders);
    res.end(body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
    res.end(JSON.stringify({ error: 'upstream', detail: String(err?.message || err) }));
  }
}

// Rewrite every media URI so it routes back through THIS proxy (which serves
// valid HTTPS). Segments on the CDN (e.g. `/hls/<token>`) become
// `<selfBase>/api/stream-proxy?target=<encoded absolute CDN url>`.
function rewritePlaylist(text, resolvedUrl, selfBase) {
  if (!text) return text;
  let base;
  try {
    base = new URL(resolvedUrl);
  } catch {
    return text;
  }
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      let abs;
      try {
        abs = new URL(t, base);
      } catch {
        return line;
      }
      const s = abs.toString();
      const proxied = `${selfBase}/api/stream-proxy?target=${encodeURIComponent(s)}`;
      if (s.indexOf('api/stream-proxy') >= 0) return line; // already ours
      return proxied;
    })
    .join('\n');
}
