import type { ArtifactRecord } from "../../api/artifacts";
import { artifactKindLabel, artifactOwnerLabel } from "./artifactsPageModel";
import { runStagePath, runStreamPath } from "../../routes";

export type ArtifactDetailMeta = {
  title: string;
  kind: string;
  kindLabel: string;
  ownerLabel: string;
  sizeLabel: string;
  contentType: string;
  createdLabel: string;
  updatedLabel: string;
  hashLabel: string;
  runId: string | null;
  stageId: string | null;
  runPath: string | null;
  stagePath: string | null;
};

export function formatArtifactSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function formatArtifactTimestamp(iso: string): string {
  if (!Number.isFinite(Date.parse(iso))) return iso;
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
}

export function shortContentHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

export function artifactDetailMeta(
  record: ArtifactRecord,
  contentHash?: string | null,
): ArtifactDetailMeta {
  const runId = record.source.run_id;
  const stageId = record.source.stage_id;
  return {
    title: record.title,
    kind: record.kind,
    kindLabel: artifactKindLabel(record.kind),
    ownerLabel: artifactOwnerLabel(record.owner),
    sizeLabel: formatArtifactSize(record.size_bytes),
    contentType: record.content_type ?? "—",
    createdLabel: formatArtifactTimestamp(record.created_at),
    updatedLabel: formatArtifactTimestamp(record.updated_at),
    hashLabel: shortContentHash(contentHash ?? record.content_hash),
    runId,
    stageId,
    runPath: runId ? runStreamPath(runId) : null,
    stagePath: runId && stageId ? runStagePath(runId, stageId) : null,
  };
}
