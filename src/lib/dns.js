// Multi-DNS login failover. Replicates Roku buildLoginServerQueue:
//  - CVC aliases are raced in parallel so the fastest DNS on THIS device wins,
//    then the remaining non-CVC panels are tried sequentially.
//  - Remote servers.json is merged ahead of the embedded fallback; if the
//    remote is unreachable / empty / 404 we keep the embedded list.
import { login, SERVER_INFO } from './xtream.js';
import { corsFetch, proxiedGet } from './cors.js';
import { STREAM_PROXY_URLS } from './proxy.js';
import { saveSession } from './session.js';

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

// ---- Last good server (per username) ----------------------------------------
const LAST_GOOD_KEY = 'swiftstv.lastServer.v1';
const SERVERS_CACHE_KEY = 'swiftstv.serversJson.v1';

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function getLastGoodServer(username) {
  const map = readJson(LAST_GOOD_KEY, {});
  const k = String(username || '').trim().toLowerCase();
  return (map && map[k]) || '';
}

export function rememberGoodServer(username, baseUrl) {
  const k = String(username || '').trim().toLowerCase();
  if (!k || !baseUrl) return;
  const map = readJson(LAST_GOOD_KEY, {}) || {};
  map[k] = normalizeBaseUrl(baseUrl);
  writeJson(LAST_GOOD_KEY, map);
}

// servers.json with a short timeout; falls back to the last copy we saw.
async function loadServerConfigFast(timeoutMs = 3500) {
  const cached = readJson(SERVERS_CACHE_KEY, null);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const fresh = loadServerConfig()
    .then((cfg) => {
      if (cfg && (cfg.servers?.length || cfg.cvcAliases?.length)) writeJson(SERVERS_CACHE_KEY, cfg);
      return cfg;
    })
    .catch(() => null);
  const cfg = await Promise.race([fresh, timeout]);
  if (cfg) return cfg;
  if (cached && (cached.servers?.length || cached.cvcAliases?.length)) return cached;
  return { servers: EMBEDDED_SERVERS, cvcAliases: EMBEDDED_CVC_ALIASES };
}

// Full login flow with multi-DNS failover.
//
//  0) Try the server that worked last time for this user (one request, ~0.5 s).
//  1) Otherwise race EVERY server in parallel. Each one goes through the
//     corsFetch chain (direct HTTPS → Hetzner VPS → Cloudflare /proxy) and the
//     first server that authenticates wins — we no longer wait for the slowest
//     one, and we no longer start with the Cloudflare /proxy that these panels
//     answer with 403.
//  2) A server reached through the VPS is stream-reachable by definition; for a
//     direct win we keep the quick "can the stream proxy reach it?" check.
//
// Returns { ok, status, info, serverInfo, session, attempt, total, reason? }.
export async function loginWithFailover(username, password) {
  if (!username || !password) return { ok: false, reason: 'empty' };

  // Start loading servers.json right away (in parallel with step 0).
  const configPromise = loadServerConfigFast();

  // ---- Step 0: last good server -------------------------------------------
  const last = getLastGoodServer(username);
  if (last) {
    const r = await login({ baseUrl: last, username, password, noSave: true, timeoutMs: 9000 });
    if (r.ok) {
      rememberGoodServer(username, last);
      return finalize({ baseUrl: last, username, password, via: r.via, result: r }, 1, 1);
    }
  }

  const { servers, cvcAliases } = await configPromise;
  const queue = buildQueue(servers, cvcAliases, username, password).filter(
    (e) => !last || normalizeBaseUrl(e.baseUrl) !== normalizeBaseUrl(last),
  );
  if (!queue.length) return { ok: false, reason: 'network', status: 'network', attempt: 1, total: 1 };

  // ---- Step 1: parallel race, first playable server wins ----------------
  const all = [];
  const winner = await new Promise((resolve) => {
    let pending = queue.length;
    let decided = false;
    const settleOne = () => {
      pending -= 1;
      if (pending === 0 && !decided) {
        decided = true;
        resolve(null);
      }
    };
    queue.forEach((entry) => {
      login({ ...entry, noSave: true, timeoutMs: 20000 })
        .then(async (result) => {
          const item = { ...entry, via: result?.via, result };
          all.push(item);
          if (decided || !result?.ok) return;
          const server = result.session || entry;
          const reachable = result.via === 'vps' ? true : await isStreamModeReachable(server, 4000);
          if (reachable && !decided) {
            decided = true;
            resolve(item);
          } else if (!reachable) {
            // eslint-disable-next-line no-console
            console.warn('[dns] login ok but stream unreachable via proxy, skipping', entry.baseUrl);
          }
        })
        .catch((err) => {
          all.push({ ...entry, result: { ok: false, status: SERVER_INFO.NETWORK, error: err } });
        })
        .finally(settleOne);
    });
  });

  if (winner) {
    rememberGoodServer(username, winner.result.session?.baseUrl || winner.baseUrl);
    return finalize(winner, all.length, queue.length);
  }

  // ---- Decide the honest failure message --------------------------------
  // A real "invalid/expired/…" verdict from a server that responded (2xx with
  // a credential problem) is authoritative. If every server failed with
  // non-2xx/network, the servers are unreachable — not bad credentials.
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

// --- Helper: pick a panel whose STREAM mode is actually reproducible ---------

// True when this panel responds 2xx through at least one external stream proxy.
// Panels that 403 every cloud range (e.g. some block Cloudflare AND AWS) fail
// login fine but can NEVER stream from the web app, so we skip them.
async function isStreamModeReachable(server, timeoutMs = 6000) {
  const base = String(server?.baseUrl || '').trim();
  if (!base || STREAM_PROXY_URLS.length === 0) {
    // No external proxy configured → can't verify, assume reachable.
    return true;
  }
  const probeUrl = `${base}/player_api.php?username=${encodeURIComponent(
    server.username
  )}&password=${encodeURIComponent(server.password)}`;
  const enc = encodeURIComponent(probeUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const proxyBase of STREAM_PROXY_URLS) {
      const base = proxyBase.replace(/\/+$/, '');
      try {
        const res = await fetch(`${base}?target=${enc}`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'IPTVSmartersPlayer', 'Cache-Control': 'no-cache' },
        });
        if (res.ok) return true;
      } catch {
        // try next proxy
      }
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  // The parallel logins each called saveSession() internally, so whichever
  // finished last could have overwritten the session. Re-persist the chosen
  // (stream-playable) panel's session here as the source of truth.
  if (r?.session) saveSession({ ...r.session, user_info: r.info || null });
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
