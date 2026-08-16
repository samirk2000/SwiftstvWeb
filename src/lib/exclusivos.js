// Exclusivos Swiftstv — dynamic remote catalog + proxy config.
//
// Replicates Roku ExclusiveChannelsTask + proxy_playback.brs:
//  - Catalog JSON comes from GitHub (fallback jsDelivr), a bare channel list
//    must NOT wipe an already-published proxy config.
//  - Source types: hls|direct (play directly), m3u (parse #EXTINF + urls),
//    json (parse nested list), extract (regex-extract .m3u8 from HTML).
//  - "Needs origin headers" is detected DYNAMICALLY against the published
//    proxy_base_url / derived host / proxy_path — never hardcoded hosts.
import { corsFetch } from './cors.js';

export const REMOTE_CONFIG_URLS = [
  'https://raw.githubusercontent.com/samirk2000/swiftstv-exclusivos/main/exclusive_sources.json',
  'https://cdn.jsdelivr.net/gh/samirk2000/swiftstv-exclusivos@main/exclusive_sources.json',
];

export const DEFAULT_USER_AGENT = 'VLC/3.0.18 LibVLC/3.0.18';

// Embedded proxy config, published first so a cold start / registry wipe
// never clears it. A remote bare channel list won't overwrite this.
const EMBEDDED_CONFIG = {
  module_name: 'Exclusivos Swiftstv',
  user_agent: DEFAULT_USER_AGENT,
  proxy_base_url: 'https://api.swiftstv.com',
  proxy_path: '/v1/play.m3u8',
  proxy_headers: {
    referer: 'https://tudeporteshoy.xyz/',
    origin: 'https://tudeporteshoy.xyz',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
  sources: [],
};

// In-memory config holder (immutable swap on publish) — the single source of
// truth for dynamic proxy behavior within a session.
let publishedConfig = {
  proxyBase: EMBEDDED_CONFIG.proxy_base_url,
  proxyPath: EMBEDDED_CONFIG.proxy_path,
  proxyHeaders: normalizeHeaders(EMBEDDED_CONFIG.proxy_headers),
};

let catalogPromise = null;
let cachedCatalog = null;

function normalizeHeaders(hdrs) {
  const out = { referer: '', origin: '', user_agent: '' };
  if (!hdrs) return out;
  out.referer = String(hdrs.referer || '').trim();
  out.origin = String(hdrs.origin || '').trim();
  out.user_agent = String(hdrs.user_agent || hdrs.useragent || '').trim();
  if (!out.origin) out.origin = out.referer;
  return out;
}

export function getProxyConfig() {
  return publishedConfig;
}

// Publish a config ONLY if it actually carries proxy info (proxy_base_url
// and/or proxy_headers). A bare channel list must not wipe the published one.
export function publishProxyConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return publishedConfig;
  const baseUrl = String(cfg.proxy_base_url || cfg.proxy_base || '').trim();
  const path = String(cfg.proxy_path || '').trim() || '/v1/play';
  const hdrObj = cfg.proxy_headers || cfg.origin_headers || null;
  const headersFound = Boolean(hdrObj && typeof hdrObj === 'object');
  const hasProxyCfg = Boolean(baseUrl || headersFound);

  if (hasProxyCfg) {
    publishedConfig = {
      ...publishedConfig,
      proxyBase: baseUrl || publishedConfig.proxyBase,
      proxyPath: path,
      proxyHeaders: headersFound ? normalizeHeaders(hdrObj) : publishedConfig.proxyHeaders,
    };
  }
  return publishedConfig;
}

async function fetchText(url) {
  const res = await corsFetch(url, { userAgent: 'SwiftstvExclusive/1.0' });
  if (!res.ok) return '';
  return res.text;
}

function parseJsonBody(text) {
  if (!text) return null;
  const start = text.search(/[{[]/);
  if (start > 0) text = text.slice(start);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asConfig(parsed) {
  if (Array.isArray(parsed)) return { sources: parsed };
  if (parsed && typeof parsed === 'object') return parsed;
  return null;
}

// Fetch the remote catalog (cache-busted per spec) and merge proxy config.
export async function fetchCatalog(force = false) {
  if (cachedCatalog && !force) return cachedCatalog;

  // Publish embedded FIRST so cold start never loses proxy config.
  publishProxyConfig(EMBEDDED_CONFIG);

  let chosen = { sources: [] };
  let ok = false;
  for (const url of REMOTE_CONFIG_URLS) {
    try {
      // Cache-bust before publishing so a manual refresh always picks up edits.
      const text = await fetchText(cacheBust(url));
      const parsed = asConfig(parseJsonBody(text));
      if (parsed) {
        publishProxyConfig(parsed);
        chosen = parsed;
        ok = true;
        break;
      }
    } catch {
      // try next URL
    }
  }

  if (!ok) chosen = asConfig(EMBEDDED_CONFIG) || { sources: [] };

  const grouped = buildCatalog(Array.isArray(chosen.sources) ? chosen.sources : []);
  cachedCatalog = {
    config: publishedConfig,
    sources: grouped.sources,
    channels: grouped.channels,
    count: grouped.sources.length,
  };
  return cachedCatalog;
}

function buildCatalog(sourceDefs) {
  const sources = [];
  const channels = [];
  for (const def of sourceDefs) {
    const name = String(def.name || def.id || 'Exclusivo');
    const type = (String(def.type || 'direct') || 'direct').toLowerCase();
    const logo = String(def.logo || '');
    const urls = sourceUrls(def);
    sources.push({ name, type, logo, sourceId: String(def.id || ''), urls });

    // Flatten channel-list types at parse time so the UI just renders items.
    if (type === 'hls' || type === 'direct' || type === '') {
      if (urls.length) channels.push(channel(name, urls[0], urls, logo, type, String(def.id || '')));
    } else {
      channels.push({ name, type, logo, urls, sourceId: String(def.id || ''), needsFetch: true });
    }
  }
  return { sources, channels };
}

function channel(name, url, urls, logo, type, sourceId) {
  return { name, url, mirrors: urls, logo, type, sourceId };
}

function sourceUrls(src) {
  const list = [];
  if (Array.isArray(src.urls)) {
    for (const u of src.urls) {
      const s = String(u || '').trim();
      if (s && !/^https?:\/\/TU-/i.test(s)) list.push(s);
    }
  }
  if (src.url) list.push(String(src.url).trim());
  return list;
}

// Parse an m3u body into channels (title, logo, url) — Roku exclusiveParseM3u.
export function parseM3u(body) {
  const out = [];
  let title = '';
  let logo = '';
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      title = extinfName(line);
      logo = extinfLogo(line);
    } else if (!line.startsWith('#') && /^http/i.test(line)) {
      out.push({ name: title || `Exclusivo ${out.length + 1}`, url: line, logo });
      title = '';
      logo = '';
    }
  }
  return out;
}

function extinfName(line) {
  const commaAt = line.lastIndexOf(',');
  return commaAt >= 0 ? line.slice(commaAt + 1).trim() : '';
}

function extinfLogo(line) {
  const key = 'tvg-logo=';
  const idx = line.toLowerCase().indexOf(key);
  if (idx < 0) return '';
  const rest = line.slice(idx + key.length);
  const match = /^["']([^"']+)["']/.exec(rest);
  if (match) return match[1];
  const wmatch = /^\s*([^\s]+)/.exec(rest);
  return wmatch ? wmatch[1] : '';
}

// Parse a json list body into channels — Roku exclusiveParseJsonList.
export function parseJsonList(body) {
  const parsed = parseJsonBody(body);
  if (!parsed) return [];
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed.channels || parsed.streams || parsed.sources;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const name = String(row.name || row.title || '');
    let url = String(row.url || row.file || row.src || '').trim();
    const logo = String(row.logo || row.tvg_logo || '').trim();
    const outRow = { name, url, logo, mirrors: [url] };
    if (Array.isArray(row.mirrors)) {
      for (const m of row.mirrors) {
        const s = String(m || '').trim();
        if (s && s !== url) outRow.mirrors.push(s);
      }
      if (row.mirrors.length) outRow.url = outRow.mirrors[0];
    }
    if (url) {
      outRow.name = name || `Exclusivo ${out.length + 1}`;
      out.push(outRow);
    }
  }
  return out;
}

// Regex-extract the first http...m3u8 from HTML — Roku exclusiveExtractM3u8.
export function extractM3u8(html) {
  if (!html) return '';
  const m = /https?:\/\/[^\s"'<>()]+?\.m3u8/i.exec(html);
  return m ? m[0] : '';
}

function cacheBust(url) {
  const stamp = Date.now();
  return url.includes('?') ? `${url}&t=${stamp}` : `${url}?t=${stamp}`;
}

// --- Dynamic proxy / origin-header behaviour ----------------------------

// Host portion of a base URL, stripping scheme and trailing :port.
export function proxyHost(baseUrl) {
  let u = String(baseUrl || '');
  u = u.replace(/^https?:\/\//i, '');
  u = u.split('/')[0];
  u = u.split(':')[0];
  return u.toLowerCase();
}

// Derived host from the Origin: header — used to recognize the exclusive CDN.
function originHeaderHost(headers) {
  if (!headers) return '';
  const origin = String(headers.origin || headers.referer || '').trim();
  return proxyHost(origin);
}

// True when a URL belongs to the exclusive HLS proxy (base/host/path), so its
// 404 / "evento no disponible" responses are treated as a scheduled gap.
export function isAgendaProxyUrl(url) {
  const lu = String(url || '').toLowerCase();
  if (!lu) return false;
  const cfg = publishedConfig;
  const host = proxyHost(cfg.proxyBase);
  const path = cfg.proxyPath ? cfg.proxyPath.toLowerCase() : '';
  if (cfg.proxyBase && lu.includes(cfg.proxyBase.toLowerCase())) return true;
  if (host && lu.includes(host)) return true;
  if (path && lu.includes(path)) return true;
  return false;
}

// True for the exclusive origin CDN (the remote config's origin host).
export function isAgendaCdnUrl(url) {
  if (isAgendaProxyUrl(url)) return true;
  const lu = String(url || '').toLowerCase();
  if (!lu) return false;
  const origin = originHeaderHost(publishedConfig.proxyHeaders);
  return Boolean(origin && lu.includes(origin));
}

// Dynamic decision: needs Referer/Origin headers iff the URL is the exclusive
// proxy/CDN, or once an exclusive playback is active. Xtream /live/ does not.
export function needsOriginHeaders(url, opts = {}) {
  if (isAgendaCdnUrl(url)) return true;
  if (opts.exclusivePlaybackActive) return true;
  return false;
}

// The Referer / Origin / User-Agent lines to attach for exclusive streams.
export function originHeaderLines() {
  const h = publishedConfig.proxyHeaders;
  const lines = [];
  if (h.referer) lines.push(`Referer: ${h.referer}`);
  if (h.origin) lines.push(`Origin: ${h.origin}`);
  lines.push(`User-Agent: ${h.user_agent || DEFAULT_USER_AGENT}`);
  return lines;
}

export function defaultOriginHeaders() {
  return { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', Accept: '*/*' };
}
