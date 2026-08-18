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
const { URL } = require('url');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Primary agent for HTTPS upstreams. Ignore invalid self-signed certificates so
// panels/CDN IPs with broken TLS still stream.
const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
// For HTTP upstreams (http://IP:port CDNs).
const HTTP_AGENT = new http.Agent({ keepAlive: true });

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

  // Pass the browser's Range straight to the CDN so <video> can seek.
  const upstreamHeaders = {
    'User-Agent': UPSTREAM_UA,
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  const range = req.get('range');
  if (range) upstreamHeaders.Range = range;

  upstreamFetch(t.toString(), upstreamHeaders, 0, (err, upRes) => {
    if (err) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
      res.end(JSON.stringify({ error: 'upstream', detail: String(err && err.message || err) }));
      return;
    }

    const upStream = upRes;

    const ct = String(upRes.headers['content-type'] || 'application/octet-stream');
    const isPlaylist = /mpegurl|vnd\.apple/i.test(ct);
    const outHeaders = { 'Content-Type': ct, ...ALLOW_CORS };

    if (isPlaylist) {
      // Buffer the manifest, rewrite URIs to route back through this proxy,
      // then send as one response. Manifests are small.
      let body = '';
      upStream.setEncoding('utf8');
      upStream.on('data', (chunk) => (body += chunk));
      upStream.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
        res.end(JSON.stringify({ error: 'playlist', detail: String(e && e.message || e) }));
      });
      upStream.on('end', () => {
        const rewritten = rewritePlaylist(body, upRes.url || t.toString(), selfBase);
        outHeaders['Content-Length'] = Buffer.byteLength(rewritten);
        res.writeHead(upRes.statusCode || 200, outHeaders);
        res.end(rewritten);
      });
    } else {
      // Binary (mp4/TS/audio): stream straight through. Relay framing headers.
      const len = upRes.headers['content-length'];
      if (len) outHeaders['Content-Length'] = len;
      const status = upRes.statusCode || 200;
      if (status >= 200 && status < 300 && range) {
        if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];
        outHeaders['Accept-Ranges'] = 'bytes';
      }
      res.writeHead(status, outHeaders);
      upStream.on('error', () => res.destroy());
      res.on('close', () => upStream.destroy());
      upStream.pipe(res);
    }
  });
});

// Standard 404 for anything else.
app.use((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json', ...ALLOW_CORS });
  res.end(JSON.stringify({ error: 'not found' }));
});

/**
 * Follows redirects manually using Node's http/https.request so we can attach an
 * `https.Agent({ rejectUnauthorized: false })` to bypass invalid CDN certs.
 * Calls back with the FINAL upstream stream (piped later) and its IncomingMessage.
 */
function upstreamFetch(urlStr, headers, redirects, cb) {
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
    timeout: UPSTREAM_TIMEOUT_MS || undefined,
  };

  const upstreamReq = httpModule.request(opts, (upRes) => {
    const status = upRes.statusCode || 0;
    // Follow 30x to the CDN (limit the hop count).
    if (status >= 301 && status <= 308 && upRes.headers.location && redirects < MAX_REDIRECTS) {
      upRes.resume(); // drain so the socket can be reused
      let next = upRes.headers.location;
      if (!/^https?:\/\//i.test(next)) next = new URL(next, url).toString();
      return upstreamFetch(next, headers, redirects + 1, cb);
    }
    // Attach final URL for playlist rewriting.
    upRes.url = urlStr;
    cb(null, upRes);
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  upstreamReq.on('error', (e) => cb(e));
  upstreamReq.end();
}

/**
 * Rewrite every media URI in an HLS playlist so it routes back through THIS
 * proxy (which serves valid HTTPS). Lines already pointing at us are untouched.
 */
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
      if (s.includes(selfBase)) return line; // already ours
      return `${selfBase}/stream?target=${encodeURIComponent(s)}`;
    })
    .join('\n');
}

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[stream-proxy] listening on :${PORT}`);
  });
}

module.exports = app;
