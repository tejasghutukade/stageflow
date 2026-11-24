export type ArtifactOwner =
  | { kind: "stage"; pipeline: string; stage: string }
  | { kind: "agent"; agent: string };

export const ARTIFACT_STATUSES = ["available", "expired"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_EXPIRED_REASONS = [
  "run_slimmed",
  "run_purged",
  "run_deleted",
  "file_missing",
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
  status: ArtifactStatus;
  expired_at: string | null;
  expired_reason: ArtifactExpiredReason | null;
  project: { id: string; registered: boolean };
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
  expires_at: string | null;
  status: string;
  expired_at: string | null;
  expired_reason: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

export function artifactRecord(row: ArtifactRow, registered: boolean): ArtifactRecord {
  const owner: ArtifactOwner =
    row.owner_kind === "agent"
      ? { kind: "agent", agent: row.owner_agent ?? "" }
      : { kind: "stage", pipeline: row.owner_pipeline ?? "", stage: row.owner_stage ?? "" };
  const ownerKey =
    owner.kind === "agent" ? `agent:${owner.agent}` : `stage:${owner.pipeline}:${owner.stage}`;
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
    status: row.status === "expired" ? "expired" : "available",
    expired_at: row.expired_at,
    expired_reason: expiredReason(row.expired_reason),
    project: { id: row.project_root_id, registered },
  };
}

function expiredReason(value: string | null): ArtifactExpiredReason | null {
  if (
    value === "run_slimmed" ||
    value === "run_purged" ||
    value === "run_deleted" ||
    value === "file_missing"
  ) {
    return value;
  }
  return null;
}
