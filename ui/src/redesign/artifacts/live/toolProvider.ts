import type { ArtifactLiveBinding, ArtifactSnapshot } from "../../../api/artifacts";
import { queryArtifactBinding, type ArtifactBindingQueryResponse } from "../../../api/artifacts";
import { cachedLiveQuery, canonicalJson } from "../liveData/queryCache";

export {
  canonicalJson,
  clearLiveQueryCache,
  LIVE_QUERY_CACHE_MAX,
  LIVE_QUERY_CACHE_MS,
  liveQueryCacheSizeForTests,
  resetLiveQueryCacheForTests,
} from "../liveData/queryCache";

export type LiveQuery = (input: {
  bindingId: string;
  args: Record<string, unknown>;
}) => Promise<{ status: number; body: ArtifactBindingQueryResponse | { error?: string; code?: string; retry_after_seconds?: number } | null; networkError?: string }>;

type QueryResult = Awaited<ReturnType<LiveQuery>>;

function mergedArgs(binding: ArtifactLiveBinding, called: Record<string, unknown>): Record<string, unknown> {
  return { ...binding.args, ...called };
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
      const value = await cachedLiveQuery(key, async () => valueFromQuery(await input.query({ bindingId: binding.id, args: argsForHost })));
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
