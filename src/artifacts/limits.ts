export const STATIC_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
export const LIVE_PROGRAM_MAX_BYTES = 128 * 1024;
export const LIVE_BINDING_MAX = 8;
export const LIVE_BINDING_ARGS_MAX_BYTES = 8 * 1024;
export const LIVE_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const LIVE_REFRESH_MIN_SECONDS = 30;
export const LIVE_BINDING_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const ARTIFACT_TITLE_MAX_CHARS = 120;
export const ARTIFACT_DESCRIPTION_MAX_CHARS = 2000;
export const ARTIFACT_SUMMARY_MAX_CHARS = 2000;
export const ARTIFACT_TAG_MAX = 8;
export const ARTIFACT_TAG_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const DEFAULT_ARTIFACT_VERSIONS_KEEP = 10;
export const ARTIFACT_VERSIONS_KEEP_ENV = "STAGEFLOW_ARTIFACT_VERSIONS_KEEP";

export type ArtifactIssue = { path: string; message: string; code?: string };

export class ArtifactPublishError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: ArtifactIssue[],
    readonly projectRoots?: string[],
  ) {
    super(message);
    this.name = "ArtifactPublishError";
  }
}

export function artifactVersionsToKeep(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ARTIFACT_VERSIONS_KEEP_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ARTIFACT_VERSIONS_KEEP;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new ArtifactPublishError(
      400,
      "artifact.invalid_shape",
      `${ARTIFACT_VERSIONS_KEEP_ENV} must be an integer from 1 to 1000`,
      [{ path: ARTIFACT_VERSIONS_KEEP_ENV, message: "must be an integer from 1 to 1000" }],
    );
  }
  const value = Number(text);
  if (value < 1 || value > 1000) {
    throw new ArtifactPublishError(
      400,
      "artifact.invalid_shape",
      `${ARTIFACT_VERSIONS_KEEP_ENV} must be an integer from 1 to 1000`,
      [{ path: ARTIFACT_VERSIONS_KEEP_ENV, message: "must be an integer from 1 to 1000" }],
    );
  }
  return value;
}
