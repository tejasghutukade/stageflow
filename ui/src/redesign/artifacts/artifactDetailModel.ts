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

export type ArtifactVersionListItem = {
  version: number;
  size_bytes: number | null;
  content_hash: string | null;
  created_at: string;
  pinned: boolean;
  current: boolean;
  kind?: string | null;
};

export function recordForViewedVersion<T extends { kind: string }>(
  record: T,
  versions: readonly { version: number; kind?: string | null }[],
  version: number | undefined,
): T {
  if (version === undefined) return record;
  const match = versions.find((item) => item.version === version);
  if (typeof match?.kind !== "string" || match.kind.length === 0) return record;
  return { ...record, kind: match.kind };
}

export type ArtifactVersionRowModel = {
  version: number;
  createdLabel: string;
  sizeLabel: string;
  hashLabel: string;
  current: boolean;
  pinned: boolean;
};

export function artifactVersionRows(versions: readonly ArtifactVersionListItem[]): ArtifactVersionRowModel[] {
  return versions.map((version) => ({
    version: version.version,
    createdLabel: formatArtifactTimestamp(version.created_at),
    sizeLabel: formatArtifactSize(version.size_bytes),
    hashLabel: shortContentHash(version.content_hash),
    current: version.current,
    pinned: version.pinned,
  }));
}

export function viewingVersionBanner(version: number, latest: number): string {
  return `Viewing version ${version} of ${latest}`;
}

export function deleteArtifactConfirm(title: string, versionCount: number): { title: string; body: string } {
  const count = versionCount === 1 ? "1 version" : `${versionCount} versions`;
  return {
    title: `Delete ${title}?`,
    body: `This removes the published artifact "${title}" and all of its versions (${count}), including the files kept in the artifact store. This cannot be undone.`,
  };
}
