/**
 * SwiftstvWeb stream proxy — Express (Node) for a Hetzner VPS + PM2 + Nginx.
 *
 * Port of `api/stream-proxy.js` (Vercel) / `stream-proxy/mod.ts` (Deno) with the
 * additions required for a self-managed VPS:
 *
 *   - `https.Agent({ rejectUnauthorized: false })` so we can pull HLS manifests
 *     and VOD from the CDN IPs that serve an INVALID TLS certificate (they're
 *     addressed by raw IP, so validation would fail).
 *   - `User-Agent: IPTVSmartersPlayer/1.0` injected on every upstream request
 *     (the panels expect the IPTV Smarters browser identity).
 *   - Full CORS headers so any origin (the Cloudflare Pages frontend or a dev
 *     server) can call us; OPTIONS preflight handled.
 *   - HLS playlists are REWRITTEN so every segment/child-playlist URL routes
 *     back through THIS proxy (so the browser only talks to our valid HTTPS).
 *   - Binary (mp4/TS) is STREAMED straight through with Range passthrough so a
 *     <video> can seek on multi-hundred-MB VOD files without buffering them all.
 *
 * Usage:
 *   GET /stream?target=<encodeURIComponent("https://panel/live/U/P/ID.m3u8")>
 *
 * The frontend proxies VOD/series/live through this host. Point the web app at
 * it with:
 *   VITE_STREAM_PROXY_URLS="https://proxy.yourdomain.com/stream"
 *
 * Runtime: Node >= 18 (has global fetch & streams). Install: `npm i express`.
 */

'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const { Transform } = require('node:stream');
const { URL } = require('url');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Primary agent for HTTPS upstreams. Ignore invalid self-signed certificates so
// panels/CDN IPs with broken TLS still stream. `keepAlive: true` keeps each
// underlying TCP socket open between requests so the panel does NOT register a
// disconnect/reconnect per `.ts` segment. `maxSockets: 50` caps per-host
// sockets high enough that HLS parallel segment fetches are never serialized
// (which would stall playback), while still letting free sockets be reused.
const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 50 });
// For HTTP upstreams (http://IP:port CDNs) — same persistent-socket reuse.
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 50 });

// Run length of a slow/HLS DVR stream before timing out upstream sockets.
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 0);
// Max redirect hops we'll follow from a panel to its CDN.
const MAX_REDIRECTS = 8;

const ALLOW_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};

// User-Agent the Xtream panels expect. The "/1.0" suffix matches IPTV Smarters.
const UPSTREAM_UA = 'IPTVSmartersPlayer/1.0';

app.disable('x-powered-by');

// --- CORS preflight ------------------------------------------------------
app.options('*', (req, res) => {
  res.writeHead(204, ALLOW_CORS);
  res.end();
});

// --- Health / info -------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, service: 'swiftstv-stream-proxy', time: Date.now() }));
});

// --- The stream proxy ----------------------------------------------------
app.get('/stream', (req, res) => {
  const target = typeof req.query.target === 'string' ? req.query.target.trim() : '';
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...ALLOW_CORS });
    res.end(JSON.stringify({ error: 'missing "target"' }));
    return;
  }

  let t;
  try {
    t = new URL(target);
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

  // selfBase = the public base of THIS proxy (behind Nginx TLS). The browser is
  // always on HTTPS, so ALWAYS rewrite with https regardless of what
  // X-Forwarded-Proto Nginx reported (if it lacks the header/port 80 slipped
  // through, we must not emit http:// segment URLs — the page would block them
  // as mixed content). Use the incoming Host for the domain.
  const host = req.get('x-forwarded-host') || req.get('host');
  const selfBase = `https://${host}`;

  // Headers every Xtream panel/CDN expects. Always include a player UA so VOD
  // mp4/mkv requests aren't rejected with 403. Refer to the ORIGINAL host so
  // CDNs that validate the referrer don't block the redirected request.
  const upstreamHeaders = {
    'User-Agent': UPSTREAM_UA,
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: `${t.protocol}//${t.host}/`,
  };
  // Forward the browser's Range to the CDN so <video> can seek on VOD.
  const range = req.get('range');
  if (range) upstreamHeaders.Range = range;
  // Pass through auth/cookie headers from the client if the panel/CDN needs
  // them (e.g. token-in-cookie or Bearer) — preserve the original UA/Range too.
  const auth = req.get('authorization');
  if (auth) upstreamHeaders.Authorization = auth;
  const cookie = req.get('cookie');
  if (cookie && req.get('x-forward-cookies')) upstreamHeaders.Cookie = cookie;
  const extraRef = req.get('referer');
  if (extraRef) upstreamHeaders.Referer = extraRef;

  // `handle` lets the upstreamFetch redirect chain be aborted at ANY moment
  // (including mid-connect), even before it reaches a final stream. `job.cancel`
  // lets later teardown (onClientGone) stop the upstream cleanly. We do NOT
  // persist a per-session lock here: cancelling previously-started fragments on
  // arrival of a new one corrupts the HLS buffer (partial 98/131 kB chunks are
  // cut mid-download and the player freezes). Fragments must be allowed to
  // finish naturally; connection reuse is handled by keepAlive agents + the
  // frontend HLS buffer config.
  const handle = { cancelled: false, cancel: () => {} };
  const job = { cancelled: false, res: null, destroyed: false };
  job.handle = handle;
  job.cancel = () => {
    if (job.destroyed) return;
    job.destroyed = true;
    job.cancelled = true;
    handle.cancelled = true;
    try { handle.cancel(); } catch {}
    if (job.res && typeof job.res.controller === 'function') {
      try { job.res.controller(); } catch {}
    } else if (job.res && typeof job.res.destroy === 'function') {
      try { job.res.destroy(); } catch {}
    }
  };

  upstreamFetch(t.toString(), upstreamHeaders, 0, handle, (err, upRes) => {
    if (job.cancelled) {
      // The client went away before we finished starting — drop upstream.
      if (upRes) { try { upRes.destroy(); } catch {} }
      return;
    }
    if (err) {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
      res.end(JSON.stringify({ error: 'upstream', detail: String(err && err.message || err) }));
      return;
    }

    job.res = upRes;
    const upStream = upRes;
    // Abort the upstream request (and its sockets) as soon as the CLIENT goes
    // away or a NEWER request takes this session's lock over. We listen to the
    // real disconnect signals:
    //   - res 'close' / 'error': the response socket is torn down (the <video>
    //     element or an `onError` cleanup drops the connection, so the response
    //     object can be destroyed without us noticing otherwise).
    //   - req 'aborted': the client explicitly cancelled the request (the
    //     accurate request-side signal for a GET proxy).
    // NOTE: we deliberately do NOT use plain `req.on('close')` here — for a
    // GET request that fires as soon as the request line/headers are parsed
    // (normal completion), BEFORE the stream starts, so it would wrongly abort
    // every connection. `req.on('aborted')` is the signal that means the client
    // actually went away.
    const onClientGone = () => {
      job.cancel();
      res.destroy();
    };
    req.on('aborted', onClientGone);
    res.on('close', onClientGone);
    res.on('error', onClientGone);

    const ct = String(upRes.headers['content-type'] || 'application/octet-stream');
    const isPlaylist = /mpegurl|vnd\.apple/i.test(ct);
    const status = upRes.statusCode || 200;
    const outHeaders = {};

    if (isPlaylist) {
      // --- Playlist (m3u8): rewrite URIs so every child/segment routes back
      // through this proxy. One small response, no streaming needed.
      Object.assign(outHeaders, ALLOW_CORS, { 'Content-Type': ct });
      let body = '';
      upStream.setEncoding('utf8');
      upStream.on('data', (chunk) => (body += chunk));
      upStream.on('error', (e) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
        res.end(JSON.stringify({ error: 'playlist', detail: String(e && e.message || e) }));
      });
      upStream.on('end', () => {
        if (res.writableEnded || res.destroyed) return;
        const rewritten = rewritePlaylist(body, upRes.url || t.toString(), selfBase);
        outHeaders['Content-Length'] = Buffer.byteLength(rewritten);
        res.writeHead(200, outHeaders);
        res.end(rewritten);
      });
      return;
    }

    // Copy the upstream headers of interest (type, length, range framing, etag…).
    copyUpstreamHeaders(upRes.headers, outHeaders);
    outHeaders['Content-Type'] = ct;
    // The CDN often echoes a bogus Accept-Ranges (e.g. "0-<size>") or omits it.
    // Force the correct value so <video> performs byte-range seeks for VOD.
    outHeaders['Accept-Ranges'] = 'bytes';

    // CORS for the browser regardless of what the origin sends.
    Object.assign(outHeaders, ALLOW_CORS);
    delete outHeaders['cache-control']; // keep no-store (injected below)

    if (status >= 200 && status < 300) {
      // If the origin returned a Content-Range/Content-Length, they were copied
      // above. For a fresh 200 (no Range requested) the full Content-Length is
      // relayed, letting the browser stream progressively.
      outHeaders['Cache-Control'] = 'no-store';
    }

    res.writeHead(status, outHeaders);
    // Tie the lifetime of the upstream socket to the client response and vice
    // versa so aborts don't leak sockets and streams close promptly. The shared
    // onClientGone (above) already aborts upstream on req/res close/error.
    upStream.on('error', () => res.destroy());
    // Stream pure passthrough with a larger write highWaterMark than the 16 KB
    // default: for multi-MB TS/mp4 segments this writes bigger chunks per flush,
    // reducing syscall overhead and keeping the pipe at the CDN's bitrate.
    const joiner = new Transform({
      highWaterMark: 256 * 1024,
      transform(chunk, _enc, cb) {
        cb(null, chunk);
      },
    });
    upStream.pipe(joiner).pipe(res);
  });
});

// Copy the headers that matter for streaming/range integrity straight through.
// Case-insensitive; keep them as the origin sent them (Node lower-cases).
function copyUpstreamHeaders(src, out) {
  if (!src) return;
  for (const key of Object.keys(src)) {
    const v = src[key];
    if (v === undefined) continue;
    switch (key) {
      // Framing / identity that MUST pass untouched so Range works.
      case 'content-length':
      case 'content-range':
      case 'content-type':
      case 'last-modified':
      case 'etag':
      case 'date':
        out[key] = v;
        break;
      default:
        break; // ignore everything else (auth/cache headers we don't control)
    }
  }
}

// Standard 404 for anything else.
app.use((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json', ...ALLOW_CORS });
  res.end(JSON.stringify({ error: 'not found' }));
});

/**
 * Follows redirects manually using Node's http/https.request so we can attach an
 * `https.Agent({ rejectUnauthorized: false })` to bypass invalid CDN certs.
 * Calls back with the FINAL upstream stream (piped later) and its IncomingMessage.
 *
 * The returned stream also carries a `.controller()` that aborts the CURRENT
 * upstream request (even mid redirect-chain). The `/stream` route calls it on
 * client disconnect so no TCP socket stays open against the IPTV origin.
 *
 * `handle` is `{ cancelled, cancel }`. `handle.cancel` is re-pointed at each hop
 * so an external catch-up (a newer request taking this session's lock over, or
 * a client abort) can tear down the in-flight HTTP request immediately, even
 * while it is still connecting / following redirects.
 */
function upstreamFetch(urlStr, headers, redirects, handle, cb) {
  let url;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return cb(e);
  }

  const isHttps = url.protocol === 'https:';
  const httpModule = isHttps ? https : http;
  const agent = isHttps ? INSECURE_AGENT : HTTP_AGENT;
  const opts = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'GET',
    headers,
    agent,
    // Run a hard socket timeout by DEFAULT so a hung panel never keeps the
    // connection open forever. If the operator explicitly set
    // UPSTREAM_TIMEOUT_MS (e.g. for long DVR windows), that value wins.
    timeout: UPSTREAM_TIMEOUT_MS || 10000,
  };

  let cancel = () => {};
  const upstreamReq = httpModule.request(opts, (upRes) => {
    const status = upRes.statusCode || 0;
    // Final effective URL of this hop (also what playlist URIs resolve against).
    upRes.url = url.toString();
    // Give every hop's response a way to abort the whole request chain, so a
    // client disconnect or a take-over during a later hop still stops the
    // earlier sockets.
    upRes.controller = () => {
      cancel();
      upRes.destroy();
    };
    // Stop immediately if a newer stream for the same session has cancelled us.
    if (handle.cancelled) {
      upRes.destroy();
      return;
    }
    // Follow 30x to the CDN (limit the hop count) — same headers (UA/Range/
    // Authorization/Referer) are reused verbatim on the redirected request so
    // the CDN still sees a player identity and doesn't 403.
    if (status >= 301 && status <= 308 && upRes.headers.location && redirects < MAX_REDIRECTS) {
      // If we've been taken over during the 3xx, don't chase it.
      if (handle.cancelled) {
        upRes.destroy();
        return;
      }
      upRes.resume(); // drain so the socket can be reused
      let next = upRes.headers.location;
      if (!/^https?:\/\//i.test(next)) next = new URL(next, url).toString();
      return upstreamFetch(next, headers, redirects + 1, handle, cb);
    }
    cb(null, upRes);
  });

  // Point the shared handle at THIS hop's request so an external cancel aborts
  // it immediately (not just at the next hop boundary).
  handle.cancel = () => upstreamReq.destroy();
  cancel = () => upstreamReq.destroy();
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  upstreamReq.on('error', (e) => {
    if (handle.cancelled) return; // we were cancelled; not an error to surface
    cb(e);
  });
  upstreamReq.end();
}

/**
 * Rewrite every media URI in an HLS playlist so it routes back through THIS
 * proxy (which serves valid HTTPS). Lines already pointing at us are untouched.
 * Processed line-by-line so a fragment/master manifest (usually < a few KB)
 * rewrites in microseconds and never buffers more than one response.
 */
function rewritePlaylist(text, resolvedUrl, selfBase) {
  if (!text) return text;
  let base;
  try {
    base = new URL(resolvedUrl);
  } catch {
    return text;
  }

  const lines = text.split(/\r?\n/);
  const out = new Array(lines.length);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.charCodeAt(0) === 35 /* '#' */ || line.trim() === '') {
      out[i] = line; // EXTM3U / EXINF / blank stay untouched
      continue;
    }
    let abs;
    try {
      abs = new URL(line, base);
    } catch {
      out[i] = line;
      continue;
    }
    const s = abs.toString();
    if (s.startsWith(selfBase) || s.includes('stream?target=')) {
      out[i] = line; // already ours
      continue;
    }
    out[i] = `${selfBase}/stream?target=${encodeURIComponent(s)}`;
    changed = true;
  }
  return changed ? out.join('\n') : text;
}

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[stream-proxy] listening on :${PORT}`);
  });
}

module.exports = app;
