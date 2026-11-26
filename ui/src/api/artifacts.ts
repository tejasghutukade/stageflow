import { api } from "./client";
import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";

export type ArtifactOwner =
  | { kind: "stage"; pipeline: string; stage: string }
  | { kind: "agent"; agent: string };

export type ArtifactPublishedKind =
  | "static.markdown"
  | "static.image"
  | "static.table"
  | "static.text"
  | "static.html"
  | "live.declarative"
  | "live.html";

export type ArtifactLiveStatus = "fresh" | "stale" | "refreshing" | "error";

export type ArtifactLiveBinding = {
  id: string;
  function: string;
  args: Record<string, unknown>;
};

export type ArtifactLiveAction = {
  id: string;
  type: "message" | "tool";
  label: string;
  template: string;
  tool?: string;
};

export type ArtifactLiveView = {
  status: ArtifactLiveStatus | null;
  last_refreshed_at?: string | null;
  last_error_code?: string | null;
  bindings?: ArtifactLiveBinding[];
  actions?: ArtifactLiveAction[];
  refresh?: { on_view?: boolean; ttl_seconds?: number; auto_seconds?: number };
  library?: { name: string; version: string };
  libraries?: Array<{ name: string; version: string; allowEval?: boolean }>;
  format?: string;
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  origins?: ArtifactOriginView;
};

export type ArtifactOriginView = {
  connect: string[];
  resource: string[];
  base: string[];
  hash: string;
  approved: boolean;
  approved_at: string | null;
};

export type ArtifactSnapshot = {
  binding_id: string;
  args_hash: string;
  value: unknown;
  fetched_at: string;
  duration_ms: number;
  status: string;
  error_code: string | null;
  source?: "cache" | "executed";
};

/** Matches the Host default when a live manifest omits `refresh.ttl_seconds`. */
export const DEFAULT_LIVE_TTL_SECONDS = 300;

/** Matches the Host floor for `refresh.ttl_seconds` and `refresh.auto_seconds`. */
export const LIVE_REFRESH_MIN_SECONDS = 30;

/** Current live component library. Matches `LIBRARY_NAME` / `LIBRARY_VERSION` in `src/artifacts/library`. */
export const LIVE_LIBRARY_NAME = "stageflow";
export const LIVE_LIBRARY_VERSION = "1.0.0";
export const LIVE_OPENUI_FORMAT = "openui-lang";

export function effectiveLiveTtlSeconds(ttl: number | undefined): number {
  if (typeof ttl !== "number" || !Number.isInteger(ttl)) return DEFAULT_LIVE_TTL_SECONDS;
  return Math.max(LIVE_REFRESH_MIN_SECONDS, ttl);
}

export type ArtifactDataResponse = {
  status: ArtifactLiveStatus | string | null;
  snapshots: ArtifactSnapshot[];
  last_refreshed_at: string | null;
  last_error_code: string | null;
  errors: Array<{ binding_id: string; code: string }>;
  retry_after_seconds?: number;
};

export type ArtifactRecord = {
  key: string;
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  kind: ArtifactPublishedKind | (string & {});
  origin: string;
  owner: ArtifactOwner;
  source: {
    run_id: string | null;
    stage_id: string | null;
    attempt: number | null;
    session_id: string | null;
  };
  version: number;
  size_bytes: number | null;
  content_type: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  project: { id: string; registered: boolean };
  status: "available" | "expired";
  expired_at: string | null;
  expired_reason: string | null;
  content_hash?: string | null;
  live?: ArtifactLiveView;
};

export type ArtifactListSort = "updated" | "title" | "size";
export type ArtifactListOrder = "asc" | "desc";

export type ArtifactListQueryParams = {
  project_root?: string;
  limit?: number;
  cursor?: string;
  status?: "available" | "expired";
  kind?: string;
  owner?: string;
  tag?: string;
  live?: boolean;
  sort?: ArtifactListSort;
  order?: ArtifactListOrder;
  q?: string;
};

export type ArtifactListPage = {
  artifacts: ArtifactRecord[];
  next_cursor: string | null;
  match_count?: number;
};

export function artifactListSearchParams(
  projectRoot: string | undefined,
  options?: ArtifactListQueryParams,
): URLSearchParams {
  const params = new URLSearchParams();
  if (projectRoot) params.set("project_root", projectRoot);
  params.set("limit", String(options?.limit ?? 50));
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.status) params.set("status", options.status);
  if (options?.kind) params.set("kind", options.kind);
  if (options?.owner) params.set("owner", options.owner);
  if (options?.tag) params.set("tag", options.tag);
  if (options?.live === true) params.set("live", "true");
  if (options?.live === false) params.set("live", "false");
  if (options?.sort) params.set("sort", options.sort);
  if (options?.order) params.set("order", options.order);
  if (options?.q) params.set("q", options.q);
  return params;
}

export function fetchArtifacts(
  projectRoot?: string,
  options?: ArtifactListQueryParams,
  init?: RequestInit,
): Promise<ArtifactListPage> {
  const params = artifactListSearchParams(projectRoot, options);
  const query = params.toString();
  return api(`/api/artifacts${query ? `?${query}` : ""}`, init);
}

export class ArtifactRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: string | undefined, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ArtifactRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function artifactQuery(projectRoot?: string, version?: number): string {
  const params = new URLSearchParams();
  if (projectRoot) params.set("project_root", projectRoot);
  if (version !== undefined) params.set("version", String(version));
  const query = params.toString();
  return query ? `?${query}` : "";
}

function artifactRecordPath(ownerKey: string, id: string, projectRoot?: string, version?: number): string {
  return `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}${artifactQuery(projectRoot, version)}`;
}

export function artifactContentPath(
  ownerKey: string,
  id: string,
  projectRoot?: string,
  version?: number,
): string {
  return `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}/content${artifactQuery(projectRoot, version)}`;
}

async function readArtifactError(res: Response): Promise<ArtifactRequestError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    last_error_code?: string | null;
    retry_after_seconds?: number;
  };
  if (res.status === 401) notifyControlTokenRequired();
  return new ArtifactRequestError(
    res.status,
    body.code ?? body.last_error_code ?? undefined,
    body.error ?? body.last_error_code ?? `Request failed (${res.status})`,
    body.retry_after_seconds,
  );
}

export function fetchArtifact(
  ownerKey: string,
  id: string,
  projectRoot?: string,
  version?: number,
): Promise<ArtifactRecord> {
  return api(artifactRecordPath(ownerKey, id, projectRoot, version));
}

export type ArtifactContentPayload =
  | { kind: "text"; text: string; contentType: string; contentHash: string | null; size: number }
  | { kind: "image"; objectUrl: string; contentType: string; contentHash: string | null; size: number }
  | { kind: "binary"; contentType: string; contentHash: string | null; size: number };

export async function fetchArtifactContent(
  ownerKey: string,
  id: string,
  projectRoot?: string,
  version?: number,
): Promise<ArtifactContentPayload> {
  const res = await fetch(artifactContentPath(ownerKey, id, projectRoot, version), {
    headers: { ...authorizationHeaders() },
  });
  if (!res.ok) throw await readArtifactError(res);
  const contentType = res.headers.get("content-type") ?? "";
  const contentHash = res.headers.get("x-artifact-content-hash");
  if (contentType.startsWith("image/")) {
    const blob = await res.blob();
    return {
      kind: "image",
      objectUrl: URL.createObjectURL(blob),
      contentType,
      contentHash,
      size: blob.size,
    };
  }
  if (contentType.startsWith("application/octet-stream")) {
    const blob = await res.blob();
    return { kind: "binary", contentType, contentHash, size: blob.size };
  }
  const text = await res.text();
  return {
    kind: "text",
    text,
    contentType,
    contentHash,
    size: new TextEncoder().encode(text).length,
  };
}

export type ArtifactVersionRecord = {
  version: number;
  size_bytes: number | null;
  content_hash: string | null;
  created_at: string;
  pinned: boolean;
  current: boolean;
  kind: string | null;
};

export function fetchArtifactVersions(
  ownerKey: string,
  id: string,
  projectRoot?: string,
): Promise<{ versions: ArtifactVersionRecord[] }> {
  const path = `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}/versions${artifactQuery(projectRoot)}`;
  return api(path);
}

export function deleteArtifact(ownerKey: string, id: string, projectRoot?: string): Promise<{ key: string }> {
  return api(artifactRecordPath(ownerKey, id, projectRoot), { method: "DELETE" });
}

function artifactActionPath(ownerKey: string, id: string, action: "data" | "refresh", projectRoot?: string): string {
  return `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}/${action}${artifactQuery(projectRoot)}`;
}

export async function fetchArtifactData(ownerKey: string, id: string, projectRoot?: string): Promise<ArtifactDataResponse> {
  const res = await fetch(artifactActionPath(ownerKey, id, "data", projectRoot), {
    headers: { ...authorizationHeaders() },
  });
  if (!res.ok) throw await readArtifactError(res);
  return (await res.json()) as ArtifactDataResponse;
}

export type ArtifactBindingQueryResponse = {
  binding_id: string;
  args_hash: string;
  snapshot: ArtifactSnapshot | null;
  errors: Array<{ binding_id: string; code: string }>;
  retry_after_seconds?: number;
};

export async function queryArtifactBinding(
  ownerKey: string,
  id: string,
  body: { binding_id: string; args: Record<string, unknown> },
  projectRoot?: string,
): Promise<{
  status: number;
  body: ArtifactBindingQueryResponse | { error?: string; code?: string; retry_after_seconds?: number } | null;
  networkError?: string;
}> {
  try {
    const res = await fetch(
      `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}/query${artifactQuery(projectRoot)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorizationHeaders() },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await res.json().catch(() => null)) as
      | ArtifactBindingQueryResponse
      | { error?: string; code?: string; retry_after_seconds?: number }
      | null;
    if (res.status === 401) notifyControlTokenRequired();
    return { status: res.status, body: parsed };
  } catch (error) {
    return { status: 0, body: null, networkError: error instanceof Error ? error.message : String(error) };
  }
}

export async function approveArtifactOrigins(
  ownerKey: string,
  id: string,
  body: { origins_hash: string; version?: number },
  projectRoot?: string,
): Promise<{ origins: ArtifactOriginView; approved: true; approved_at: string }> {
  const res = await fetch(
    `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}/origins/approve${artifactQuery(projectRoot)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await readArtifactError(res);
  return (await res.json()) as { origins: ArtifactOriginView; approved: true; approved_at: string };
}

export async function revokeArtifactOrigins(
  ownerKey: string,
  id: string,
  projectRoot?: string,
  originsHash?: string,
): Promise<{ revoked: number; origins: ArtifactOriginView | null }> {
  const params = new URLSearchParams();
  if (projectRoot) params.set("project_root", projectRoot);
  if (originsHash) params.set("origins_hash", originsHash);
  const query = params.toString();
  const res = await fetch(
    `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}/origins/approval${query ? `?${query}` : ""}`,
    { method: "DELETE", headers: { ...authorizationHeaders() } },
  );
  if (!res.ok) throw await readArtifactError(res);
  return (await res.json()) as { revoked: number; origins: ArtifactOriginView | null };
}

export async function requestArtifactRefresh(
  ownerKey: string,
  id: string,
  projectRoot?: string,
  options?: { ifStale?: boolean; signal?: AbortSignal },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(artifactActionPath(ownerKey, id, "refresh", projectRoot), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    body: JSON.stringify(options?.ifStale ? { ifStale: true } : {}),
    signal: options?.signal,
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  return { status: res.status, body };
}
