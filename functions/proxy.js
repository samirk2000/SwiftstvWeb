/**
 * Cloudflare Pages Function — CORS-safe server-side proxy for JSON + HLS.
 *
 * Xtream panels and the Exclusivos proxy do not send `Access-Control-Allow-Origin`,
 * and live/VOD streams redirect to `http://IP:port` CDNs that a browser on an
 * HTTPS page blocks as mixed active content. This function re-issues the request
 * from Cloudflare's edge and returns the response WITH relaxed CORS headers, so
 * the frontend can call `player_api.php` AND proxy HLS media.
 *
 * Usage (from the browser):
 *   GET /proxy?target=<encodeURIComponent(url)>
 *        &ua=<optional user-agent>
 *        &referer=<optional>
 *        &origin=<optional>
 *
 * Media handling:
 *  - Redirects are followed server-side (so the panel's `302 Location:
 *    http://IP/...` to the CDN works from an HTTPS page).
 *  - Range requests are passed through, so <video>/hls.js can seek and the
 *    byte offsets stay correct on MPEG-TS segments.
 *  - `.m3u8` (playlist) responses are textually rewritten: every segment and
 *    sub-manifest URI becomes an absolute `/proxy?target=<abs>` URL on OUR
 *    origin. That keeps the browser on HTTPS for the whole stream (no mixed
 *    content) while the edge follows each request to the CDN.
 *
 * Cloudflare Pages free-tier limits (30s CPU / ~50MB body) fit short MPEG-TS
 * segments (~1MB) and tiny manifests, so this is acceptable for HLS.
 *
 * @param {import('@cloudflare/workers-types').Request} request
 * @param {import('@cloudflare/workers-types').Env} env
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('target');
  const ua = url.searchParams.get('ua') || 'IPTVSmartersPlayer';
  const referer = url.searchParams.get('referer') || '';
  const origin = url.searchParams.get('origin') || '';

  if (!target) {
    return cors(new Response(JSON.stringify({ error: 'missing "target"' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  let t;
  try {
    t = new URL(target.trim());
  } catch {
    return cors(new Response(JSON.stringify({ error: 'bad target' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    return cors(new Response(JSON.stringify({ error: 'bad target protocol' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  const headers = {
    'User-Agent': ua,
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;

  // Pass through byte-range requests so seeks keep working on TS segments and
  // large VOD files. hls.js generally only uses GET without range, but <video>
  // may issue ranges for VOD mp4.
  const range = request.headers.get('range');
  if (range) headers.Range = range;

  try {
    const upstream = await fetch(t.toString(), { headers, redirect: 'follow' });
    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = /mpegurl|application\/vnd\.apple/i.test(contentType);
    const isText = /text\/|json|xml|javascript/.test(contentType) || isPlaylist;

    let body;
    let outHeaders = new Headers();
    outHeaders.set('Content-Type', contentType || 'application/octet-stream');
    const upstreamLength = upstream.headers.get('content-length');

    if (isPlaylist) {
      // Rewrite the manifest so every media/sub-playlist URI goes through us.
      // Its byte length changes, so drop the upstream Content-Length.
      body = rewritePlaylist(await upstream.text(), upstream.url, url.origin);
    } else if (isText) {
      body = await upstream.text();
    } else {
      // Binary (MPEG-TS segments, mp4, or the auth/302-resolved target).
      body = await upstream.arrayBuffer();
      // Preserve byte-range metadata for seeks on binaries only.
      if (range) {
        const cr = upstream.headers.get('content-range');
        if (cr) outHeaders.set('Content-Range', cr);
        const ar = upstream.headers.get('accept-ranges');
        if (ar) outHeaders.set('Accept-Ranges', ar);
      }
      if (upstreamLength) outHeaders.set('Content-Length', upstreamLength);
    }

    return cors(
      new Response(body, {
        status: upstream.status,
        headers: outHeaders,
      })
    );
  } catch (err) {
    return cors(
      new Response(JSON.stringify({ error: 'upstream', detail: String(err?.message || err) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
}

// The panel serves the live manifest off a CDN IP (http://104.x.x.x:80/auth).
// Xtream VOD manifests reference `.ts`/`.m4s`/sub `.m3u8` — rewrite every URI
// line to `/proxy?target=<abs>` so the browser stays on HTTPS for the stream.
function rewritePlaylist(text, resolvedUrl, origin) {
  if (!text) return text;
  const base = new URL(resolvedUrl);
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('http')) {
        // E.g. "#EXT-X-STREAM-INF:" is followed on the next line by the URI.
        return line;
      }
      if (/^\/proxy/i.test(t)) return line; // already ours — idempotent
      let abs;
      try {
        abs = new URL(t, base).toString();
      } catch {
        return line;
      }
      return `${origin}/proxy?target=${encodeURIComponent(abs)}`;
    })
    .join('\n');
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  return new Response(res.body, { status: res.status, headers: h });
}
