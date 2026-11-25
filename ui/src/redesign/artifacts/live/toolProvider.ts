import type { ArtifactLiveBinding, ArtifactSnapshot } from "../../../api/artifacts";
import { queryArtifactBinding, type ArtifactBindingQueryResponse } from "../../../api/artifacts";

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

export type LiveQuery = (input: {
  bindingId: string;
  args: Record<string, unknown>;
}) => Promise<{ status: number; body: ArtifactBindingQueryResponse | { error?: string; code?: string; retry_after_seconds?: number } | null; networkError?: string }>;

type QueryResult = Awaited<ReturnType<LiveQuery>>;

/** In-memory window for a repeated variant query. The Host keeps the longer cache. */
export const LIVE_QUERY_CACHE_MS = 30_000;
export const LIVE_QUERY_CACHE_MAX = 64;

const queryInflight = new Map<string, Promise<unknown>>();
const queryRecent = new Map<string, { at: number; value: unknown }>();
let queryCacheEpoch = 0;

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

function mergedArgs(binding: ArtifactLiveBinding, called: Record<string, unknown>): Record<string, unknown> {
  return { ...binding.args, ...called };
}

async function dedupedQuery(key: string, run: () => Promise<unknown>): Promise<unknown> {
  const hit = queryRecent.get(key);
  if (hit && Date.now() - hit.at < LIVE_QUERY_CACHE_MS) {
    rememberQuery(key, hit.value);
    return hit.value;
  }
  const pending = queryInflight.get(key);
  if (pending) return pending;
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

function valueFromQuery(result: QueryResult): unknown {
  if (result.networkError) throw new Error(result.networkError);
  const body = result.body;
  const errors = body && "errors" in body && Array.isArray(body.errors) ? body.errors : [];
  const snapshot = body && "snapshot" in body ? body.snapshot : undefined;
  if (result.status === 200 && snapshot && (snapshot.value != null || errors.length === 0)) return snapshot.value;
  const code =
    errors[0] && "code" in errors[0]
      ? String(errors[0].code)
      : body && "code" in body && typeof body.code === "string"
        ? body.code
        : `artifact.query_failed_${result.status}`;
  throw new Error(code);
}

/**
 * OpenUI calls `Query(tool, args, default, refreshSeconds)` with `args` only.
 * `refreshSeconds` is ignored: the Host refresh policy and `useLiveArtifactData` own refresh.
 * A fourth-argument interval would refetch on a timer and reset nothing, but it would also
 * refetch while the viewer is idle. A default snapshot remounts the renderer only when its value changes.
 * Variant args share one in-flight request and a short last-result cache.
 * `clearLiveQueryCache` drops that cache on refresh and when the default value changes.
 */
export function createLiveToolProvider(input: {
  bindings: readonly ArtifactLiveBinding[];
  snapshots: readonly ArtifactSnapshot[];
  query: LiveQuery;
  historical?: boolean;
  cacheScope?: string;
  onResult?: (event: { bindingId: string; args: Record<string, unknown>; value: unknown; usedDefault: boolean }) => void;
}): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const names = new Set(input.bindings.map((binding) => binding.function));
  const scope = input.cacheScope ?? "";
  const provider: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const name of names) {
    provider[name] = async (args) => {
      const called = args ?? {};
      const matched = input.bindings.find(
        (binding) => binding.function === name && canonicalJson(binding.args) === canonicalJson(called),
      );
      if (matched) {
        const snapshot = input.snapshots.find((item) => item.binding_id === matched.id);
        const value = snapshot ? snapshot.value : null;
        input.onResult?.({ bindingId: matched.id, args: called, value, usedDefault: true });
        return value;
      }
      if (input.historical) return null;
      const binding = input.bindings.find((item) => item.function === name);
      if (!binding) throw new Error("artifact.query_unavailable");
      const argsForHost = mergedArgs(binding, called);
      const key = `${scope}\0${binding.id}\0${canonicalJson(argsForHost)}`;
      const value = await dedupedQuery(key, async () => valueFromQuery(await input.query({ bindingId: binding.id, args: argsForHost })));
      input.onResult?.({ bindingId: binding.id, args: argsForHost, value, usedDefault: false });
      return value;
    };
  }
  return provider;
}

export function liveQueryFromHost(ownerKey: string, artifactId: string, projectRoot?: string): LiveQuery {
  return async ({ bindingId, args }) => {
    try {
      return await queryArtifactBinding(ownerKey, artifactId, { binding_id: bindingId, args }, projectRoot);
    } catch (error) {
      return { status: 0, body: null, networkError: error instanceof Error ? error.message : String(error) };
    }
  };
}
