import { getLiveStreams, getVodStreams, getSeries } from './xtream.js';

/** In-memory catalog cache for global search (refreshed every 10 min). */
const TTL_MS = 10 * 60 * 1000;
let cache = {
  at: 0,
  baseUrl: '',
  username: '',
  live: [],
  vod: [],
  series: [],
};

function cacheKey(server) {
  return `${String(server?.baseUrl || '').trim()}|${String(server?.username || '')
    .trim()
    .toLowerCase()}`;
}

export async function loadCatalog(server) {
  if (!server?.baseUrl) return cache;
  const key = cacheKey(server);
  const same =
    `${cache.baseUrl}|${cache.username}` === key && Date.now() - cache.at < TTL_MS;
  if (same && (cache.live.length || cache.vod.length || cache.series.length)) {
    return cache;
  }
  const [live, vod, series] = await Promise.all([
    getLiveStreams(server).catch(() => []),
    getVodStreams(server).catch(() => []),
    getSeries(server).catch(() => []),
  ]);
  cache = {
    at: Date.now(),
    baseUrl: server.baseUrl,
    username: String(server.username || '')
      .trim()
      .toLowerCase(),
    live: Array.isArray(live) ? live : [],
    vod: Array.isArray(vod) ? vod : [],
    series: Array.isArray(series) ? series : [],
  };
  return cache;
}

export function clearCatalogCache() {
  cache = { at: 0, baseUrl: '', username: '', live: [], vod: [], series: [] };
}
