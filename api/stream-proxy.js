/**
 * Vercel mirror of the stream proxy (full rationale in `stream-proxy/mod.ts`).
 * Deployed on Vercel (AWS) — NOT Cloudflare — because the Xtream panels and
 * their CDN IPs 403 Cloudflare's ranges and the CDN serves an invalid TLS cert.
 *
 * This proxy follows the panel's 302 to the http:// CDN and rewrites every
 * playlist URI to route back through itself, so the BROWSER only talks to the
 * proxy's valid HTTPS for both the manifest and the TS segments.
 *
 * Vercel setup:
 *   - Drop this at `api/stream-proxy.js` (Vercel auto-creates the route).
 *   - Node serverless function (Web-standard Request/Response).
 *
 * Usage: GET /api/stream-proxy?target=<encodeURIComponent(panel m3u8 URL)>
 */
const ALLOW_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: ALLOW_CORS });
  }

  const url = new URL(req.url);
  const target = url.searchParams.get('target');
  if (!target) return json(400, { error: 'missing "target"' });

  let t;
  try {
    t = new URL(target.trim());
  } catch {
    return json(400, { error: 'bad target' });
  }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    return json(400, { error: 'bad target protocol' });
  }

  const selfBase = `${url.protocol}//${url.host}`;

  const headers = {
    'User-Agent': 'IPTVSmartersPlayer',
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  const range = req.headers.get('range');
  if (range) headers.Range = range;

  try {
    const upstream = await fetch(t.toString(), { headers, redirect: 'follow' });
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    const isPlaylist = /mpegurl|vnd\.apple/i.test(ct);

    let body;
    const outHeaders = { 'Content-Type': ct, ...ALLOW_CORS };
    if (isPlaylist) {
      const resolved = upstream.url;
      body = await rewritePlaylist(await upstream.text(), resolved, selfBase);
    } else {
      body = await upstream.arrayBuffer();
      const len = upstream.headers.get('content-length');
      if (len) outHeaders['Content-Length'] = len;
      if (range) {
        const cr = upstream.headers.get('content-range');
        if (cr) outHeaders['Content-Range'] = cr;
        const ar = upstream.headers.get('accept-ranges');
        if (ar) outHeaders['Accept-Ranges'] = ar;
      }
    }

    return new Response(body, { status: upstream.status, headers: outHeaders });
  } catch (err) {
    return json(502, { error: 'upstream', detail: String(err?.message || err) });
  }
}

function rewritePlaylist(text, resolvedUrl, selfBase) {
  if (!text) return text;
  const base = new URL(resolvedUrl);
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
      if (s.startsWith(selfBase)) return line;
      return `${selfBase}/?target=${encodeURIComponent(s)}`;
    })
    .join('\n');
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...ALLOW_CORS },
  });
}
