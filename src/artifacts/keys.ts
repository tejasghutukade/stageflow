import { createHash } from "node:crypto";

export const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const ID_HASH_LEN = 8;
const ID_MAX = 64;

export class ArtifactKeyError extends Error {
  readonly code = "artifact.invalid_id" as const;

  constructor(message: string) {
    super(message);
    this.name = "ArtifactKeyError";
  }
}

export function assertNoKeySeparator(value: string, label: string): void {
  if (value.includes("::")) {
    throw new ArtifactKeyError(`${label} must not contain "::"`);
  }
}

export function assertArtifactId(id: string): void {
  assertNoKeySeparator(id, "Artifact id");
  if (!ARTIFACT_ID_PATTERN.test(id)) {
    throw new ArtifactKeyError(`Artifact id is not a valid slug: ${id}`);
  }
}

function readableSlug(normalised: string): string {
  const slug = normalised
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(slug)) {
    return slug.length === 0 ? "artifact" : `artifact-${slug.replace(/^-+/, "")}`;
  }
  return slug;
}

/** Stable id: readable path slug, always followed by 8 hex chars of sha256(normalised path). */
export function artifactIdFromRelative(relativePath: string): string {
  const normalised = relativePath.replace(/\\/g, "/");
  const hash = createHash("sha256").update(normalised).digest("hex").slice(0, ID_HASH_LEN);
  const room = ID_MAX - 1 - ID_HASH_LEN;
  let slug = readableSlug(normalised).slice(0, room).replace(/-+$/g, "");
  if (!/^[a-z]/.test(slug)) slug = "artifact";
  const id = `${slug}_${hash}`;
  assertArtifactId(id);
  return id;
}

export function stageOwnerKey(pipelineId: string, stageId: string): string {
  assertNoKeySeparator(pipelineId, "Pipeline id");
  assertNoKeySeparator(stageId, "Stage id");
  if (pipelineId.length === 0 || stageId.length === 0) {
    throw new ArtifactKeyError("Pipeline id and stage id are required");
  }
  return `stage:${pipelineId}:${stageId}`;
}

export function artifactStorageKey(wireProjectRoot: string, ownerKey: string, id: string): string {
  assertNoKeySeparator(wireProjectRoot, "Project id");
  assertNoKeySeparator(ownerKey, "Owner key");
  assertArtifactId(id);
  return `${wireProjectRoot}::${ownerKey}/${id}`;
}

export function publicArtifactKey(ownerKey: string, id: string): string {
  return `${ownerKey}/${id}`;
}
