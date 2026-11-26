/**
 * Isolated audio-only transcode endpoint for SwiftstvWeb VOD.
 *
 * GET /transcode-audio?target=<urlencoded http(s) VOD URL>&t=<start seconds>
 * GET /transcode-audio?probe=1   → { ok, active, max, available }  (no ffmpeg)
 *
 * ffmpeg copies video and transcodes audio AC3/E-AC3/DTS → AAC stereo 128k,
 * muxed as fragmented MP4 for Chromium / Smart TV <video>.
 *
 * Safety:
 *  - Same protocol check as /stream, plus private/loopback/link-local/metadata
 *    IP block and DNS resolution check (do not open an SSRF proxy).
 *  - Concurrency cap (MAX_TRANSCODES, default 4) → 503 { error: "capacity" }.
 *  - SIGKILL the ffmpeg child on client close / error / safety timeout.
 *  - nice(10) so nginx and the live TV relay always win CPU scheduling.
 *  - Never log the target URL (may contain panel credentials).
 */
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const os = require('os');

const FFMPEG_PATH = process.env.FFMPEG_PATH || '/opt/swiftstv/bin/ffmpeg';
const MAX_TRANSCODES = Math.max(1, Number(process.env.MAX_TRANSCODES || 4));
const TRANSCODE_TIMEOUT_MS = Number(process.env.TRANSCODE_TIMEOUT_MS || 4 * 60 * 60 * 1000);
const TRANSCODE_STARTUP_MS = Number(process.env.TRANSCODE_STARTUP_MS || 45000);
const TRANSCODE_NICE = Number(process.env.TRANSCODE_NICE || 10);
const UPSTREAM_UA = 'IPTVSmartersPlayer/1.0';

let activeTranscodes = 0;
const ffmpegReady = (() => {
  try {
    return fs.existsSync(FFMPEG_PATH) && fs.statSync(FFMPEG_PATH).isFile();
  } catch {
    return false;
  }
})();

// In-memory one-shot source tickets so the real VOD URL (which may contain
// panel credentials) never appears in `ps` / /proc cmdline. ffmpeg fetches
// http://127.0.0.1:<port>/__transcode_src/<id> and we relay with Range.
const srcTickets = new Map(); // id -> { url, expires }

function isLoopbackReq(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function makeSrcTicket(url) {
  const id = crypto.randomBytes(24).toString('hex');
  srcTickets.set(id, { url, expires: Date.now() + 8 * 60 * 60 * 1000 });
  return id;
}

function dropSrcTicket(id) {
  if (id) srcTickets.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of srcTickets) {
    if (!rec || rec.expires < now) srcTickets.delete(id);
  }
}, 60000).unref();

const V4_BLOCK = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

function ipV4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function inCidrV4(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipV4ToInt(ip) & mask) === (ipV4ToInt(base) & mask);
}

function isBlockedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return V4_BLOCK.some((c) => inCidrV4(ip, c));
  if (kind === 6) {
    const s = String(ip).toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fe80:') || s.startsWith('ff')) return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (s.startsWith('::ffff:')) {
      const v4 = s.includes('.') ? s.slice(s.lastIndexOf(':') + 1) : null;
      if (v4 && net.isIP(v4) === 4) return isBlockedIp(v4);
    }
    return false;
  }
  return true;
}

function isBlockedHostname(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata.google.com') return true;
  return false;
}

function isLoopTarget(u) {
  const host = String(u.hostname || '').toLowerCase();
  const path = String(u.pathname || '');
  if (!/\/(stream|transcode-audio)(\/|$)/i.test(path)) return false;
  return host === 'proxy.swiftstv.com' || host === '178.105.219.215' || host === '127.0.0.1' || host === 'localhost';
}

async function assertSafeTarget(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return { ok: false, error: 'bad target' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'bad target protocol' };
  }
  if (isBlockedHostname(u.hostname)) {
    return { ok: false, error: 'bad target host' };
  }
  if (isLoopTarget(u)) {
    return { ok: false, error: 'bad target host' };
  }
  if (net.isIP(u.hostname)) {
    if (isBlockedIp(u.hostname)) return { ok: false, error: 'bad target host' };
    return { ok: true, url: u };
  }
  let addrs;
  try {
    addrs = await dns.promises.lookup(u.hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: 'bad target host' };
  }
  if (!addrs || !addrs.length) return { ok: false, error: 'bad target host' };
  for (const a of addrs) {
    if (isBlockedIp(a.address)) return { ok: false, error: 'bad target host' };
  }
  return { ok: true, url: u };
}

function parseSeekSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 12 * 3600);
}

function scrubErr(s) {
  return String(s || '')
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/[?&](username|password|target)=[^&\s]*/gi, '')
    .slice(0, 400);
}

function transcodeHealth() {
  return {
    active: activeTranscodes,
    max: MAX_TRANSCODES,
    available: Math.max(0, MAX_TRANSCODES - activeTranscodes),
    ffmpeg: ffmpegReady,
  };
}

function json(res, status, cors, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
  res.end(JSON.stringify(body));
}

function mountAudioTranscode(app, { cors, upstreamFetch, port }) {
  const listenPort = Number(port || process.env.PORT || 3000);

  // Localhost-only source relay for ffmpeg. Reject anything not from loopback
  // so this can never be used as a public open proxy.
  app.get('/__transcode_src/:id', (req, res) => {
    if (!isLoopbackReq(req)) {
      json(res, 404, cors, { error: 'not found' });
      return;
    }
    const rec = srcTickets.get(String(req.params.id || ''));
    if (!rec || rec.expires < Date.now()) {
      json(res, 404, cors, { error: 'not found' });
      return;
    }
    const headers = {
      'User-Agent': UPSTREAM_UA,
      Accept: '*/*',
      'Cache-Control': 'no-cache',
    };
    const range = req.get('range');
    if (range) headers.Range = range;
    upstreamFetch(rec.url, headers, 0, (err, upRes) => {
      if (err) {
        if (!res.headersSent) json(res, 502, cors, { error: 'upstream' });
        return;
      }
      const status = upRes.statusCode || 200;
      const out = {};
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
        if (upRes.headers[key]) out[key] = upRes.headers[key];
      }
      res.writeHead(status, out);
      upRes.on('error', () => res.destroy());
      res.on('close', () => { if (!upRes.complete) upRes.destroy(); });
      upRes.pipe(res);
    });
  });

  app.get('/transcode-audio', (req, res) => {
    if (req.query.probe === '1' || req.query.probe === 'true') {
      const h = transcodeHealth();
      json(res, 200, cors, { ok: true, ...h });
      return;
    }

    const target = typeof req.query.target === 'string' ? req.query.target.trim() : '';
    if (!target) {
      json(res, 400, cors, { error: 'missing "target"' });
      return;
    }
    if (!ffmpegReady) {
      json(res, 503, cors, { error: 'unavailable', detail: 'ffmpeg missing' });
      return;
    }
    if (activeTranscodes >= MAX_TRANSCODES) {
      res.setHeader('Retry-After', '10');
      json(res, 503, cors, { error: 'capacity', active: activeTranscodes, max: MAX_TRANSCODES });
      return;
    }

    const seek = parseSeekSeconds(req.query.t);
    assertSafeTarget(target).then((safe) => {
      if (!safe.ok) {
        json(res, 400, cors, { error: safe.error || 'bad target' });
        return;
      }
      if (res.writableEnded || res.destroyed) return;
      if (activeTranscodes >= MAX_TRANSCODES) {
        res.setHeader('Retry-After', '10');
        json(res, 503, cors, { error: 'capacity', active: activeTranscodes, max: MAX_TRANSCODES });
        return;
      }
      startFfmpeg(safe.url.toString(), seek, req, res, cors, listenPort);
    }).catch(() => {
      if (!res.headersSent) json(res, 400, cors, { error: 'bad target' });
    });
  });
}

function startFfmpeg(inputUrl, seek, req, res, cors, listenPort) {
  const ticket = makeSrcTicket(inputUrl);
  const localSrc = `http://127.0.0.1:${listenPort}/__transcode_src/${ticket}`;
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-user_agent', UPSTREAM_UA,
    '-analyzeduration', '5000000',
    '-probesize', '2000000',
    '-fflags', '+genpts',
  ];
  if (seek > 0) args.push('-ss', String(seek));
  args.push(
    '-i', localSrc,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '48000',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000',
    'pipe:1',
  );

  let child;
  try {
    child = spawn('nice', ['-n', String(TRANSCODE_NICE), FFMPEG_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    json(res, 500, cors, { error: 'spawn' });
    return;
  }

  activeTranscodes += 1;
  let settled = false;
  let started = false;
  let errBuf = '';

  try {
    if (typeof child.pid === 'number') os.setPriority(child.pid, TRANSCODE_NICE);
  } catch {
    /* ignore: nice already applied via the wrapper */
  }

  const finish = () => {
    if (settled) return;
    settled = true;
    activeTranscodes = Math.max(0, activeTranscodes - 1);
    dropSrcTicket(ticket);
    clearTimeout(timer);
    clearTimeout(startupTimer);
    try {
      if (child.pid && !child.killed) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };

  const timer = setTimeout(finish, TRANSCODE_TIMEOUT_MS);
  const startupTimer = setTimeout(() => {
    if (started || settled) return;
    if (!res.headersSent && !res.destroyed) {
      json(res, 504, cors, { error: 'timeout' });
    }
    finish();
  }, TRANSCODE_STARTUP_MS);

  child.stderr.on('data', (d) => {
    if (errBuf.length < 2000) errBuf += d.toString('utf8');
  });

  child.stdout.on('error', () => finish());
  child.on('error', () => {
    if (!res.headersSent) json(res, 500, cors, { error: 'spawn' });
    finish();
  });
  child.on('exit', () => {
    if (!started && !res.headersSent && !res.destroyed && !res.writableEnded) {
      json(res, 502, cors, { error: 'transcode', detail: scrubErr(errBuf) || 'ffmpeg exit' });
    } else if (started && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* ignore */ }
    }
    finish();
  });

  req.on('close', finish);
  res.on('close', finish);
  req.on('aborted', finish);

  child.stdout.once('data', (chunk) => {
    if (settled || res.headersSent) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none',
      ...cors,
    });
    res.write(chunk);
    child.stdout.pipe(res);
  });
}

module.exports = {
  mountAudioTranscode,
  transcodeHealth,
  assertSafeTarget,
  isBlockedIp,
  MAX_TRANSCODES,
};
