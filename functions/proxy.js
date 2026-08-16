/**
 * Cloudflare Pages Function — CORS-safe server-side proxy.
 *
 * Xtream panels and the Exclusivos proxy do not send `Access-Control-Allow-Origin`,
 * so a static browser page cannot fetch them. This function re-issues the request
 * from Cloudflare's edge and returns the response WITH relaxed CORS headers, so
 * the frontend can call `player_api.php`, the Exclusivos config/sources, etc.
 *
 * Usage (from the browser):
 *   GET /proxy?target=<encodeURIComponent(url)>
 *        &ua=<optional user-agent>
 *        &referer=<optional>
 *        &origin=<optional>
 *
 * The proxy DOES NOT proxy streaming video (`.m3u8`/`.mp4`/segments). HLS.js /
 * <video> fetch those natively; proxying media would break range requests and
 * the Exclusivos 302-to-CDN redirect that the native player must follow.
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

  const t = new URL(target.trim());
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

  try {
    const upstream = await fetch(t.toString(), { headers, redirect: 'follow' });
    const body = await (upstream.status >= 300
      ? upstream.text()
      : upstream.arrayBuffer());
    return cors(
      new Response(body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        },
      }),
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

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  return new Response(res.body, { status: res.status, headers: h });
}
