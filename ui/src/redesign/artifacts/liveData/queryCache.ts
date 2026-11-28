/** In-memory window for a repeated variant query. The Host keeps the longer cache. */
export const LIVE_QUERY_CACHE_MS = 30_000;
export const LIVE_QUERY_CACHE_MAX = 64;

const queryInflight = new Map<string, Promise<unknown>>();
const queryRecent = new Map<string, { at: number; value: unknown }>();
let queryCacheEpoch = 0;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key]);
    return sorted;
  }
  return value;
}

export function resetLiveQueryCacheForTests(): void {
  queryInflight.clear();
  queryRecent.clear();
  queryCacheEpoch = 0;
}

export function clearLiveQueryCache(): void {
  queryCacheEpoch += 1;
  queryRecent.clear();
}

export function liveQueryCacheSizeForTests(): number {
  return queryRecent.size;
}

function rememberQuery(key: string, value: unknown): void {
  if (queryRecent.has(key)) queryRecent.delete(key);
  queryRecent.set(key, { at: Date.now(), value });
  while (queryRecent.size > LIVE_QUERY_CACHE_MAX) {
    const oldest = queryRecent.keys().next().value;
    if (oldest === undefined) break;
    queryRecent.delete(oldest);
  }
}

export async function cachedLiveQuery<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = queryRecent.get(key);
  if (hit && Date.now() - hit.at < LIVE_QUERY_CACHE_MS) {
    rememberQuery(key, hit.value);
    return hit.value as T;
  }
  const pending = queryInflight.get(key);
  if (pending) return pending as Promise<T>;
  const epoch = queryCacheEpoch;
  const promise = (async () => {
    try {
      const value = await run();
      if (epoch === queryCacheEpoch) rememberQuery(key, value);
      return value;
    } finally {
      queryInflight.delete(key);
    }
  })();
  queryInflight.set(key, promise);
  return promise;
}
