import { parseStoredHtmlManifest, type HtmlCsp } from "./htmlManifest.js";
import { isLiveHtmlKind, isLiveKind } from "./kinds.js";
import { parseStoredLiveManifest } from "./manifest.js";
import type { ArtifactOriginView } from "./originApproval.js";
import { artifactOwnerKey, ownerFromRow, type ArtifactOwner } from "./owners.js";

export { artifactOwnerKey, type ArtifactOwner } from "./owners.js";

export const ARTIFACT_STATUSES = ["available", "expired"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_EXPIRED_REASONS = [
  "run_slimmed",
  "run_purged",
  "run_deleted",
  "file_missing",
  "session_expired",
] as const;
export type ArtifactExpiredReason = (typeof ARTIFACT_EXPIRED_REASONS)[number];

export type ArtifactRecord = {
  key: string;
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  kind: string;
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
  scope: "project" | "session";
  status: ArtifactStatus;
  expired_at: string | null;
  expired_reason: ArtifactExpiredReason | null;
  project: { id: string; registered: boolean };
  live?: ArtifactLiveView | null;
};

export type ArtifactLiveStatus = "fresh" | "stale" | "refreshing" | "error";

export type ArtifactLiveAction = {
  id: string;
  type: "message" | "tool";
  label: string;
  template: string;
  tool?: string;
};

export type ArtifactLiveView = {
  status: ArtifactLiveStatus | null;
  last_refreshed_at: string | null;
  last_error_code: string | null;
  bindings: Array<{ id: string; function: string; args: Record<string, unknown> }>;
  refresh?: { on_view?: boolean; ttl_seconds?: number; auto_seconds?: number };
  library?: { name: string; version: string };
  libraries?: Array<{ name: string; version: string; allowEval?: boolean }>;
  format?: string;
  csp?: HtmlCsp;
  origins?: ArtifactOriginView;
  actions?: ArtifactLiveAction[];
};

export type ArtifactRow = {
  key: string;
  owner_kind: string;
  owner_pipeline: string | null;
  owner_stage: string | null;
  owner_agent: string | null;
  project_root_id: string;
  id: string;
  title: string;
  description: string | null;
  tags_json: string;
  summary: string | null;
  kind: string;
  origin: string;
  current_version: number;
  source_run_id: string | null;
  source_stage_id: string | null;
  source_attempt: number | null;
  source_session_id: string | null;
  hidden: number;
  scope?: string | null;
  expires_at: string | null;
  status: string;
  expired_at: string | null;
  expired_reason: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  content_type: string | null;
  size_bytes: number | null;
  live_status?: string | null;
  last_refreshed_at?: string | null;
  last_error_code?: string | null;
  manifest_json?: string | null;
};

const LIVE_STATUSES = new Set(["fresh", "stale", "refreshing", "error"]);

export function artifactRecord(row: ArtifactRow, registered: boolean): ArtifactRecord {
  const owner: ArtifactOwner = ownerFromRow(row);
  const ownerKey = artifactOwnerKey(owner);
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json) as unknown;
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")) tags = parsed;
  } catch {
    tags = [];
  }
  return {
    key: `${ownerKey}/${row.id}`,
    id: row.id,
    title: row.title,
    description: row.description,
    tags,
    kind: row.kind,
    origin: row.origin,
    owner,
    source: {
      run_id: row.source_run_id,
      stage_id: row.source_stage_id,
      attempt: row.source_attempt,
      session_id: row.source_session_id,
    },
    version: row.current_version,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    scope: row.scope === "session" ? "session" : "project",
    status: row.status === "expired" ? "expired" : "available",
    expired_at: row.expired_at,
    expired_reason: expiredReason(row.expired_reason),
    project: { id: row.project_root_id, registered },
    ...liveView(row),
  };
}

function publicActions(actions: NonNullable<ReturnType<typeof parseStoredLiveManifest>>["actions"]): ArtifactLiveAction[] | undefined {
  if (!actions || actions.length === 0) return undefined;
  return actions.map((action) => ({
    id: action.id,
    type: action.type,
    label: action.label ?? action.template.slice(0, 80),
    template: action.template,
    ...(action.tool ? { tool: action.tool } : {}),
  }));
}

export function artifactLiveManifestFields(
  kind: string,
  manifestJson: string | null | undefined,
): Pick<ArtifactLiveView, "bindings" | "refresh" | "library" | "libraries" | "format" | "csp" | "actions"> {
  if (isLiveHtmlKind(kind)) {
    const manifest = parseStoredHtmlManifest(manifestJson);
    return {
      bindings: manifest?.bindings ?? [],
      format: manifest?.format ?? "html",
      ...(manifest?.csp ? { csp: manifest.csp } : {}),
      ...(manifest?.libraries && manifest.libraries.length > 0 ? { libraries: manifest.libraries } : {}),
      ...(manifest?.refresh ? { refresh: manifest.refresh } : {}),
    };
  }
  const manifest = parseStoredLiveManifest(manifestJson);
  const actions = publicActions(manifest?.actions);
  return {
    bindings: manifest?.bindings ?? [],
    ...(manifest?.format ? { format: manifest.format } : {}),
    ...(manifest?.library ? { library: manifest.library } : {}),
    ...(manifest?.refresh ? { refresh: manifest.refresh } : {}),
    ...(actions ? { actions } : {}),
  };
}

function liveView(row: ArtifactRow): { live: ArtifactLiveView } | Record<string, never> {
  if (!isLiveKind(row.kind)) return {};
  const status = row.live_status && LIVE_STATUSES.has(row.live_status) ? (row.live_status as ArtifactLiveStatus) : null;
  const live: ArtifactLiveView = {
    status,
    last_refreshed_at: row.last_refreshed_at ?? null,
    last_error_code: row.last_error_code ?? null,
    ...artifactLiveManifestFields(row.kind, row.manifest_json),
  };
  return { live };
}

function expiredReason(value: string | null): ArtifactExpiredReason | null {
  if (
    value === "run_slimmed" ||
    value === "run_purged" ||
    value === "run_deleted" ||
    value === "file_missing" ||
    value === "session_expired"
  ) {
    return value;
  }
  return null;
}
