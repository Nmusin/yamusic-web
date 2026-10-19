const crypto = require("crypto");
const { yandexRequest } = require("./yandex");

const API_CACHE_LIMIT = 400;
const apiCache = new Map(); // key -> { resp: {status, data}, ts, hits }
const ACCOUNT_CACHE_TTL = 10 * 60 * 1000; // account/about rarely changes
const accInfoCache = new Map(); // tokenHash -> { info, ts }

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
}

function getApiCache() {
  return apiCache;
}

function getAccInfoCache() {
  return accInfoCache;
}

async function yandexCached(url, token, ttlMs) {
  const key = `${tokenHash(token)}|${url}`;
  const now = Date.now();
  const hit = apiCache.get(key);
  if (hit && now - hit.ts < ttlMs) {
    hit.hits++;
    return { status: hit.resp.status, data: hit.resp.data, cached: true };
  }
  const resp = await yandexRequest(url, token);
  if (resp.status === 200 && resp.data) {
    apiCache.set(key, { resp: { status: resp.status, data: resp.data }, ts: now, hits: 0 });
    if (apiCache.size > API_CACHE_LIMIT) {
      const oldest = apiCache.keys().next().value;
      apiCache.delete(oldest);
    }
  }
  return resp;
}

// Drop cached URLs containing `fragment` (e.g. "/likes/tracks" after a successful like)
function invalidateApiCache(fragment) {
  let n = 0;
  for (const k of Array.from(apiCache.keys())) {
    if (k.includes(fragment)) {
      apiCache.delete(k);
      n++;
    }
  }
  return n;
}

function cacheStats() {
  let hits = 0;
  for (const v of apiCache.values()) hits += v.hits || 0;
  return { entries: apiCache.size, totalHits: hits, limit: API_CACHE_LIMIT };
}

module.exports = {
  API_CACHE_LIMIT,
  ACCOUNT_CACHE_TTL,
  tokenHash,
  getApiCache,
  getAccInfoCache,
  yandexCached,
  invalidateApiCache,
  cacheStats,
};
