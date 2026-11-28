import type { ArtifactBindingQueryResponse, ArtifactLiveBinding, ArtifactSnapshot } from "../../../api/artifacts";
import { cachedLiveQuery, canonicalJson } from "../liveData/queryCache";

export const SNAPSHOT_WAIT_MS = 10_000;

export type BindingQueryResult = {
  status: number;
  body: ArtifactBindingQueryResponse | { error?: string; code?: string; retry_after_seconds?: number } | null;
  networkError?: string;
};

export type BindingQuery = (input: { bindingId: string; args: Record<string, unknown> }) => Promise<BindingQueryResult>;

export type ToolCallBody = {
  content: [{ type: "text"; text: string }];
  structuredContent: unknown;
  isError?: true;
  _meta: {
    source: "cache" | "executed";
    fetched_at: string;
    retry_after_seconds?: number;
    retryable?: boolean;
  };
};

function isToolBody(value: unknown): value is ToolCallBody {
  return typeof value === "object" && value !== null && "content" in value && "isError" in value;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function toolError(message: string, retryAfterSeconds?: number, fetchedAt = nowIso(), retryable = false): ToolCallBody {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: null,
    isError: true,
    _meta: {
      source: "executed",
      fetched_at: fetchedAt,
      ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
      ...(retryable ? { retryable: true } : {}),
    },
  };
}

export function bindingCacheScope(projectRoot: string | undefined, ownerKey: string, artifactId: string, version: number): string {
  return `${projectRoot ?? ""}\0${ownerKey}\0${artifactId}\0${version}`;
}

function snapshotBody(snapshot: ArtifactSnapshot, fallback: "cache" | "executed"): ToolCallBody {
  const source = snapshot.source === "cache" || snapshot.source === "executed" ? snapshot.source : fallback;
  const value = snapshot.value === undefined ? null : snapshot.value;
  const fetched = snapshot.fetched_at && snapshot.fetched_at.length > 0 ? snapshot.fetched_at : nowIso();
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    _meta: { source, fetched_at: fetched },
  };
}

function retryAfter(body: BindingQueryResult["body"]): number | undefined {
  if (!body || typeof body !== "object" || !("retry_after_seconds" in body)) return undefined;
  const value = body.retry_after_seconds;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorCode(body: BindingQueryResult["body"]): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  if ("errors" in body && Array.isArray(body.errors) && body.errors[0] && typeof body.errors[0].code === "string") {
    return body.errors[0].code;
  }
  if ("code" in body && typeof body.code === "string") return body.code;
  return undefined;
}

function shortCode(code: string | undefined): string {
  if (code && /^artifact\.[a-z0-9_.]+$/.test(code) && code.length <= 80) return code;
  return "query failed";
}

export function mapQueryResult(result: BindingQueryResult): ToolCallBody {
  if (result.networkError) return toolError("network error");
  const retry = retryAfter(result.body);
  if (result.status === 503) return toolError("the server is busy", retry);
  const body = result.body;
  const snapshot = body && "snapshot" in body ? body.snapshot : undefined;
  const errors = body && "errors" in body && Array.isArray(body.errors) ? body.errors : [];
  if (result.status === 200 && snapshot && (snapshot.value != null || errors.length === 0)) {
    return snapshotBody(snapshot, "executed");
  }
  return toolError(shortCode(errorCode(body)), retry);
}

export function createBindingCaller(input: {
  bindings: readonly ArtifactLiveBinding[];
  getSnapshots: () => readonly ArtifactSnapshot[];
  /** True while the data hook is still loading or a refresh is in flight. */
  pending: () => boolean;
  aborted?: () => boolean;
  historical: boolean;
  waitForSnapshot: (bindingId: string, timeoutMs: number) => Promise<void>;
  query: BindingQuery;
  cacheScope: string;
}): (name: string, args: Record<string, unknown> | undefined) => Promise<ToolCallBody> {
  return async (name, args) => {
    const binding = input.bindings.find((item) => item.id === name);
    if (!binding) return toolError("unknown binding");
    if (input.historical) return toolError("no data for this version");
    const useDefault = args === undefined || canonicalJson(args) === canonicalJson(binding.args);
    if (useDefault) {
      const read = () => input.getSnapshots().find((item) => item.binding_id === binding.id);
      let snapshot = read();
      if (!snapshot && input.pending()) {
        await input.waitForSnapshot(binding.id, SNAPSHOT_WAIT_MS);
        if (input.aborted?.()) return toolError("no data yet", undefined, nowIso(), true);
        snapshot = read();
      }
      if (!snapshot) return toolError("no data yet", undefined, nowIso(), true);
      return snapshotBody(snapshot, "cache");
    }
    const called = args ?? {};
    const key = `${input.cacheScope}\0${binding.id}\0${canonicalJson(called)}`;
    try {
      return await cachedLiveQuery(key, async () => {
        const mapped = mapQueryResult(await input.query({ bindingId: binding.id, args: called }));
        if (mapped.isError) throw mapped;
        return mapped;
      });
    } catch (error) {
      if (isToolBody(error)) return error;
      return toolError("query failed");
    }
  };
}
