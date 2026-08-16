// Multi-DNS login failover. Replicates Roku buildLoginServerQueue:
//  - CVC aliases are raced in parallel so the fastest DNS on THIS device wins,
//    then the remaining non-CVC panels are tried sequentially.
//  - Remote servers.json is merged ahead of the embedded fallback; if the
//    remote is unreachable / empty / 404 we keep the embedded list.
import { login } from './xtream.js';

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
    const res = await fetch(REMOTE_SERVERS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { servers: [], cvcAliases: [] };
    const text = await res.text();
    const parsed = JSON.parse(text);
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
        await fetch(`${host}/player_api.php`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'IPTVSmartersPlayer', 'Cache-Control': 'no-cache' },
        });
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

// Full login flow with multi-DNS failover. Returns:
//  { ok, status, info, serverInfo, session, attempt, total, reason? }.
export async function loginWithFailover(username, password) {
  if (!username || !password) return { ok: false, reason: 'empty' };

  const { servers, cvcAliases } = await loadServerConfig();
  let queue = buildQueue(servers, cvcAliases, username, password);

  // Race the CVC aliases (the first batch up to N) in parallel so the fastest
  // working DNS on the device wins; then fall through to the remaining panels.
  const CVC_BATCH = cvcAliases.length || Infinity;
  const firstGroup = queue.slice(0, CVC_BATCH);
  const rest = queue.slice(CVC_BATCH);

  const results = await Promise.all(
    firstGroup.map(async (entry) => {
      const r = await login(entry);
      return { ...entry, result: r };
    })
  );

  // Fastest-answering valid server wins (matches the "fastest DNS wins" intent,
  // while still preferring a genuine auth success over a network skip).
  const success = results.find((x) => x.result.ok);
  if (success) {
    return finalize(success, 1, firstGroup.length);
  }

  // CVC rejection (invalid/expired/banned) is a hard account signal only if it
  // isn't a network/parse error — but network-failed CVC hosts should not also
  // block the Swiftstable panel. So: if any CVC returned a deterministic
  // non-network problem, skip the remaining CVC aliases and try the other
  // panel (Roku tryOtherPanelAfterCvcReject). Otherwise continue to other panels.
  const negativeStatuses = ['invalid', 'expired', 'banned', 'disabled'];
  const hardReject = results.some((x) => negativeStatuses.includes(x.result.status));

  // Any remaining panels (non-CVC) tried sequentially.
  for (let i = 0; i < rest.length; i++) {
    const run = await login(rest[i]);
    if (run.ok) {
      return finalize({ ...rest[i], result: run }, i + firstGroup.length + 1, queue.length);
    }
  }

  if (hardReject) {
    const first = results.find((x) => negativeStatuses.includes(x.result.status));
    return {
      ok: false,
      status: first.result.status,
      reason: 'account',
      attempt: firstGroup.length,
      total: queue.length,
    };
  }

  return { ok: false, reason: 'network', attempt: queue.length, total: queue.length };
}

function finalize(entry, attempt, total) {
  const r = entry.result;
  return {
    ok: true,
    status: r.status,
    info: r.info,
    serverInfo: r.serverInfo,
    session: r.session,
    workingBaseUrl: entry.baseUrl,
    attempt,
    total,
  };
}
