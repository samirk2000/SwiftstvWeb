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

// --- Short in-memory cache for Xtream player_api LIST actions ---------------
// Categories / streams / vod / series lists are big JSON (up to ~30 MB) and
// change rarely. Cache them for a few minutes, stored gzip-compressed.
// Never cached: get_user_info / auth (no action), EPG, info calls, streams.
// Key = panel host + username + sha256(password) + action + category_id, so a
// wrong password never gets someone else's cached list.
const zlib = require('zlib');
const crypto = require('crypto');
const LIST_CACHE_TTL_MS = Number(process.env.LIST_CACHE_TTL_MS || 180000); // 3 min
const LIST_CACHE_MAX_BYTES = Number(process.env.LIST_CACHE_MAX_BYTES || 100 * 1024 * 1024); // gz bytes
const LIST_CACHE_MAX_RAW = 80 * 1024 * 1024; // don't keep bodies larger than this
const LIST_ACTIONS = new Set([
  'get_live_categories', 'get_vod_categories', 'get_series_categories',
  'get_live_streams', 'get_vod_streams', 'get_series',
]);
const listCache = new Map(); // key -> { gz, size, ct, exp }
let listCacheBytes = 0;

function listCacheKey(t) {
  if (!/\/player_api\.php$/i.test(t.pathname)) return null;
  const q = t.searchParams;
  const action = q.get('action') || '';
  if (!LIST_ACTIONS.has(action)) return null;
  const user = q.get('username') || '';
  const pass = q.get('password') || '';
  if (!user || !pass) return null;
  const ph = crypto.createHash('sha256').update(pass).digest('hex').slice(0, 16);
  return [t.host.toLowerCase(), user, ph, action, q.get('category_id') || ''].join('|');
}
function listCacheGet(key) {
  const e = listCache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) { listCache.delete(key); listCacheBytes -= e.size; return null; }
  listCache.delete(key); listCache.set(key, e); // LRU bump
  return e;
}
function listCachePut(key, gz, ct) {
  const old = listCache.get(key);
  if (old) { listCache.delete(key); listCacheBytes -= old.size; }
  if (gz.length > LIST_CACHE_MAX_BYTES / 4) return;
  listCache.set(key, { gz, size: gz.length, ct, exp: Date.now() + LIST_CACHE_TTL_MS });
  listCacheBytes += gz.length;
  for (const [k, e] of listCache) {
    if (listCacheBytes <= LIST_CACHE_MAX_BYTES) break;
    listCache.delete(k); listCacheBytes -= e.size;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of listCache) if (e.exp < now) { listCache.delete(k); listCacheBytes -= e.size; }
}, 60000).unref();

function sendCachedList(req, res, e, hit) {
  const base = { ...ALLOW_CORS, 'Content-Type': e.ct, 'X-Cache': hit, Vary: 'Accept-Encoding' };
  if (/\bgzip\b/i.test(req.get('accept-encoding') || '')) {
    res.writeHead(200, { ...base, 'Content-Encoding': 'gzip', 'Content-Length': e.gz.length });
    res.end(e.gz);
    return;
  }
  zlib.gunzip(e.gz, (err, raw) => {
    if (err) { res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS }); res.end('{"error":"cache"}'); return; }
    res.writeHead(200, { ...base, 'Content-Length': raw.length });
    res.end(raw);
  });
}

// Upstream list responses that must NOT be cached (errors / auth failures).
function cacheableListBody(status, ct, buf) {
  if (status !== 200 || !/json/i.test(ct) || buf.length < 2) return false;
  const head = buf.subarray(0, 300).toString('utf8').trimStart();
  if (head[0] !== '[' && head[0] !== '{') return false;
  if (/"auth"\s*:\s*0|"error"|<html/i.test(head)) return false;
  return true;
}


// --- CORS preflight ------------------------------------------------------
app.options('*', (req, res) => {
  res.writeHead(204, ALLOW_CORS);
  res.end();
});

// --- Health / info -------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, service: 'swiftstv-stream-proxy', time: Date.now(), listCache: { entries: listCache.size, bytes: listCacheBytes } }));
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

  // Cached player_api list actions (no Range on these).
  const cacheKey = range ? null : listCacheKey(t);
  if (cacheKey) {
    const hitEntry = listCacheGet(cacheKey);
    if (hitEntry) return sendCachedList(req, res, hitEntry, 'HIT');
    upstreamFetch(t.toString(), upstreamHeaders, 0, (err, upRes) => {
      if (err) {
        res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
        res.end(JSON.stringify({ error: 'upstream', detail: String(err && err.message || err) }));
        return;
      }
      const status = upRes.statusCode || 200;
      const ct = String(upRes.headers['content-type'] || 'application/json');
      // Stream straight to the client (first byte immediately, so slow panels
      // never trip nginx's read timeout) and keep a copy for the cache.
      const keep = status === 200 && /json/i.test(ct);
      const chunks = [];
      let kept = 0;
      res.writeHead(status, { ...ALLOW_CORS, 'Content-Type': ct, 'X-Cache': 'MISS' });
      upRes.on('data', (c) => {
        if (keep && kept <= LIST_CACHE_MAX_RAW) { chunks.push(c); kept += c.length; }
      });
      upRes.pipe(res); // pipe handles backpressure and ends res
      upRes.on('error', () => res.destroy());
      res.on('close', () => { if (!upRes.complete) upRes.destroy(); });
      upRes.on('end', () => {
        if (!keep || kept > LIST_CACHE_MAX_RAW || !upRes.complete) return;
        const buf = Buffer.concat(chunks);
        if (cacheableListBody(status, ct, buf)) {
          zlib.gzip(buf, { level: 6 }, (zerr, gz) => { if (!zerr) listCachePut(cacheKey, gz, ct); });
        }
      });
    });
    return;
  }

  upstreamFetch(t.toString(), upstreamHeaders, 0, (err, upRes) => {
    if (err) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
      res.end(JSON.stringify({ error: 'upstream', detail: String(err && err.message || err) }));
      return;
    }

    const upStream = upRes;

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
        if (res.writableEnded) return;
        res.writeHead(502, { 'Content-Type': 'application/json', ...ALLOW_CORS });
        res.end(JSON.stringify({ error: 'playlist', detail: String(e && e.message || e) }));
      });
      upStream.on('end', () => {
        if (res.writableEnded) return;
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
    // versa so aborts don't leak sockets and streams close promptly.
    upStream.on('error', () => res.destroy());
    res.on('close', () => upStream.destroy());
    upStream.pipe(res);
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
