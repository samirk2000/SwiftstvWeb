// Multi-DNS login failover. Replicates Roku buildLoginServerQueue:
//  - CVC aliases are raced in parallel so the fastest DNS on THIS device wins,
//    then the remaining non-CVC panels are tried sequentially.
//  - Remote servers.json is merged ahead of the embedded fallback; if the
//    remote is unreachable / empty / 404 we keep the embedded list.
import { login, SERVER_INFO } from './xtream.js';
import { corsFetch, proxiedGet } from './cors.js';

export const EMBEDDED_SERVERS = [
  'http://cvcplayer.us:8080',
  'http://swiftstable.xyz:8080',
];

export const EMBEDDED_CVC_ALIASES = [
  'http://cvcplayer.us:8080',
  'http://cavctv.xyz:8080',
  'http://cvcplayertv.xyz:8080',
];

const REMOTE_SERVERS_URL =
  'https://raw.githubusercontent.com/samirk2000/swiftstv-exclusivos/main/servers.json';

export function normalizeBaseUrl(url) {
  let u = String(url || '').trim();
  while (u.length > 0 && u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const n = normalizeBaseUrl(x);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

function asHttpList(raw) {
  const out = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = normalizeBaseUrl(item);
      if (s && /^https?:\/\//i.test(s)) out.push(s);
    }
  }
  return out;
}

// Remote servers.json: { servers: [...], cvc_aliases: [...] } or a plain array.
export async function fetchRemoteServers() {
  try {
    const res = await corsFetch(REMOTE_SERVERS_URL, { userAgent: 'IPTVSmartersPlayer' });
    if (!res.ok) return { servers: [], cvcAliases: [] };
    const parsed = JSON.parse(res.text);
    if (Array.isArray(parsed)) {
      return { servers: dedupe(asHttpList(parsed)), cvcAliases: [] };
    }
    return {
      servers: dedupe(asHttpList(parsed.servers)),
      cvcAliases: dedupe(asHttpList(parsed.cvc_aliases)),
    };
  } catch {
    return { servers: [], cvcAliases: [] };
  }
}

export function isCvcAliasHost(url, aliases) {
  const needle = normalizeBaseUrl(url);
  return aliases.some((a) => normalizeBaseUrl(a) === needle);
}

// Merge remote ahead of embedded, deduping by normalized URL.
export function mergeServerLists(remote, embedded) {
  return dedupe([...(remote || []), ...(embedded || [])]);
}

// Probe a list of hosts in parallel and order by fastest response time.
// Unreachable hosts time out and fall to the end. Mirrors Roku DnsPickTask.
const DNS_PROBE_TIMEOUT = 2500;

async function probeFastest(hosts) {
  const timed = await Promise.all(
    hosts.map(async (host) => {
      const start = performance.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DNS_PROBE_TIMEOUT);
        await proxiedGet(`${host}/player_api.php`, {
          userAgent: 'IPTVSmartersPlayer',
        }, (u) =>
          fetch(u, {
            signal: controller.signal,
            headers: { 'User-Agent': 'IPTVSmartersPlayer', 'Cache-Control': 'no-cache' },
          })
        );
        clearTimeout(timer);
      } catch {
        return { host, ms: Number.MAX_SAFE_INTEGER };
      }
      return { host, ms: performance.now() - start };
    })
  );
  timed.sort((a, b) => a.ms - b.ms);
  return timed.map((x) => x.host);
}

export async function loadServerConfig() {
  // Embedded first so cold start / remote 404 never wipe what we know works.
  const embedded = { servers: EMBEDDED_SERVERS, cvcAliases: EMBEDDED_CVC_ALIASES };
  const remote = await fetchRemoteServers();
  if (remote.servers.length === 0 && remote.cvcAliases.length === 0) return embedded;

  const servers = mergeServerLists(remote.servers, EMBEDDED_SERVERS);
  let cvcAliases = remote.cvcAliases.length
    ? dedupe(mergeServerLists(remote.cvcAliases, EMBEDDED_CVC_ALIASES))
    : EMBEDDED_CVC_ALIASES;
  return { servers, cvcAliases };
}

// Build the ordered login queue exactly like Roku buildLoginServerQueue:
// CVC aliases first (deduped, normalized, non-empty), then the remaining
// non-CVC panels. Each entry already carries its dedicated credentials.
function buildQueue(servers, cvcAliases, username, password) {
  const queue = new Set();
  const order = [];

  function pushAll(list) {
    for (const host of list || []) {
      const n = normalizeBaseUrl(host);
      if (n && !queue.has(n)) {
        queue.add(n);
        order.push(n);
      }
    }
  }

  pushAll(cvcAliases);
  for (const host of servers) {
    const n = normalizeBaseUrl(host);
    if (n && !isCvcAliasHost(n, cvcAliases) && !queue.has(n)) {
      queue.add(n);
      order.push(n);
    }
  }

  return order.map((baseUrl) => ({ baseUrl, username, password }));
}

// Full login flow with multi-DNS failover.
//
// Ranking across two rounds so panels reachable only by ONE route still work:
//  Round 1 (PROXY): every host is tried through /proxy in parallel. `ok` wins.
//    Hosts that DON'T respond 2xx (403/ERR = Cloudflare IP blocked, or network)
//    are marked `blocked` and retried via Direct in Round 2.
//    Hosts that DO respond 2xx but with INVALID_CREDENTIALS are `invalid` (the
//    server works but the account doesn't exist there) — NOT retried direct.
//  Round 2 (DIRECT): hosts that Round 1 left `blocked` are retried direct
//    (HTTPS-first) from the browser, because some panels block Cloudflare IPs
//    but accept residential IPs.
//
// Returns { ok, status, info, serverInfo, session, attempt, total, reason? }.
export async function loginWithFailover(username, password) {
  if (!username || !password) return { ok: false, reason: 'empty' };

  const { servers, cvcAliases } = await loadServerConfig();
  const queue = buildQueue(servers, cvcAliases, username, password);
  if (!queue.length) return { ok: false, reason: 'empty' };

  // ---- Round 1: proxy ranking (parallel) -------------------------------
  const viaProxy = queue.map((entry) => ({ ...entry, via: 'proxy' }));
  const round1 = await Promise.all(
    viaProxy.map(async (entry) => ({ ...entry, result: await login(entry) }))
  );

  const authOk = round1.find((x) => x.result.ok);
  if (authOk) return finalize(authOk, 1, queue.length);

  // ---- Round 2: direct retry only for hosts the proxy could not reach -----
  const needsDirect = round1.filter((x) => isProxyBlocked(x.result));
  const round2 = await Promise.all(
    needsDirect.map(async (entry) => {
      if (entry.result.ok) return entry; // can't happen, defensively
      return { ...entry, via: 'direct', result: await login({ ...entry, via: 'direct' }) };
    })
  );
  const directOk = round2.find((x) => x.result.ok);
  if (directOk) return finalize(directOk, 2, queue.length);

  // ---- Decide the honest failure message --------------------------------
  // A real "invalid/expired/…" verdict from a server that responded (2xx with
  // a credential problem) is authoritative. If only proxy/all-direct failed
  // with non-2xx/network, the servers are unreachable — not bad credentials.
  const all = [...round1, ...round2];
  const credentialVerdict = all.find((x) => isCredentialVerdict(x.result));
  if (credentialVerdict) {
    return {
      ok: false,
      status: credentialVerdict.result.status,
      reason: 'account',
      attempt: queue.length,
      total: queue.length,
      results: summarize(all),
    };
  }
  return {
    ok: false,
    status: 'network',
    reason: 'network',
    attempt: queue.length,
    total: queue.length,
    results: summarize(all),
  };
}

// True when a login result means "the proxy/panel rejected this request at the
// transport layer" (WAF 403 to Cloudflare IPs, network, parse) — i.e. the host
// MIGHT work via a different route (direct), so keep it for Round 2.
function isProxyBlocked(result) {
  if (!result) return false;
  if (result.ok) return false; // already succeeded, never blocked
  return result.status === SERVER_INFO.HTTP ||
    result.status === SERVER_INFO.NETWORK ||
    result.status === SERVER_INFO.PARSE ||
    result.httpStatus === 403 || result.httpStatus === 404 ||
    result.httpStatus === 502 || result.httpStatus === 503;
}

// A genuine account verdict from a server that actually answered (2xx body
// with invalid/expired/banned/disabled) — authoritative for the failure reason.
function isCredentialVerdict(result) {
  if (!result || result.ok) return false;
  return (
    result.status === SERVER_INFO.INVALID ||
    result.status === SERVER_INFO.EXPIRED ||
    result.status === SERVER_INFO.BANNED ||
    result.status === SERVER_INFO.DISABLED
  );
}

function summarize(list) {
  return list.map(({ baseUrl, via, result }) => ({
    baseUrl,
    via,
    status: result?.status,
    httpStatus: result?.httpStatus || (result?.ok ? 200 : 0),
  }));
}

function finalize(entry, attempt, total) {
  const r = entry.result;
  return {
    ok: true,
    status: r.status,
    info: r.info,
    serverInfo: r.serverInfo,
    session: r.session,
    // Use the effective (possibly HTTPS) base that actually worked, not the
    // original http alias — so streams aren't blocked as mixed-content.
    workingBaseUrl: r.session?.baseUrl || entry.baseUrl,
    attempt,
    total,
  };
}
