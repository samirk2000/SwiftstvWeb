/**
 * Stream proxy for Xtream panels (works on Deno Deploy; Vercel mirror in
 * `api/stream-proxy.js`). Deployed OUTSIDE Cloudflare on purpose:
 *
 *   - Xtream live/VOD/series manifests 302 from the panel to an `http://` CDN IP
 *     (mixed-content block on an HTTPS page).
 *   - The panels AND their CDN IPs 403 Cloudflare's ranges (so Pages Functions
 *     can't reach them), and the CDN's TLS cert is invalid (so a browser can't
 *     fetch its https:// directly either).
 *
 * This server runs on Deno Deploy (GCP IPs these panels don't block) and proxies
 * the WHOLE stream: it follows the panel redirect, rewrites every playlist URI to
 * go back through itself, and streams the TS/MP4 segments to the browser over the
 * proxy's own valid HTTPS. The browser never talks to the untrusted CDN.
 *
 * Usage: GET /?target=<encodeURIComponent("https://panel/live/U/P/ID.m3u8")>
 *
 * Deno Deploy: entrypoint `stream-proxy/mod.ts` → `Deno.serve(handler)`.
 */
export async function handler(req) {
  const url = new URL(req.url);
  const target = url.searchParams.get('target');
  if (!target) {
    return json(400, { error: 'missing "target"' });
  }

  let t;
  try {
    t = new URL(target.trim());
  } catch {
    return json(400, { error: 'bad target' });
  }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    return json(400, { error: 'bad target protocol' });
  }

  // Our own base URL, used to rewrite manifest URIs back to this proxy.
  const selfBase = `${url.protocol}//${url.host}`;

  const headers = {
    'User-Agent': 'IPTVSmartersPlayer',
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    // Refer the origin panel host so CDNs that validate the referrer don't 403.
    Referer: `${t.protocol}//${t.host}/`,
  };
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  // Pass through client auth if the panel/CDN needs it (Bearer/cookie tokens).
  const clientAuth = req.headers.get('authorization');
  if (clientAuth) headers.Authorization = clientAuth;

  // Follow the panel 302 → CDN http manifest. The CDN cert is invalid, but
  // server-side fetch for the manifest is over http from the panel's own
  // redirect, so no cert validation is involved for the manifest itself.
  const init = { headers, redirect: 'follow' };

  try {
    const upstream = await fetch(t.toString(), init);
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    const isPlaylist = /mpegurl|vnd\.apple/i.test(ct);

    let body;
    const outHeaders = { 'Content-Type': ct };
    if (isPlaylist) {
      const resolved = upstream.url; // after redirects → http://CDN/...manifest
      body = await rewritePlaylist(await upstream.text(), resolved, selfBase);
    } else {
      // Stream binary (mp4 / TS) straight through — VOD files are huge and
      // buffering would blow the memory limit. Range is relayed above.
      body = upstream.body;
      const len = upstream.headers.get('content-length');
      if (len) outHeaders['Content-Length'] = len;
      if (range) {
        const cr = upstream.headers.get('content-range');
        if (cr) outHeaders['Content-Range'] = cr;
        const ar = upstream.headers.get('accept-ranges');
        if (ar) outHeaders['Accept-Ranges'] = ar;
      }
    }

    return new Response(body, {
      status: upstream.status,
      headers: {
        ...outHeaders,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'no-store',
        'Access-Control-Max-Age': '86400',
      },
    });
  } catch (err) {
    return json(502, { error: 'upstream', detail: String(err?.message || err) });
  }
}

// Rewrite every media URI so it routes back through THIS proxy (which serves
// valid HTTPS). Segments on the CDN (e.g. `/hls/<token>`) become
// `<selfBase>/?target=<encoded absolute CDN url>`. Lines already https or
// pointing at us are left alone.
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
      if (s.startsWith(selfBase)) return line; // already ours
      return `${selfBase}/?target=${encodeURIComponent(s)}`;
    })
    .join('\n');
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

if (import.meta.main) {
  Deno.serve(handler);
}
export default handler;
