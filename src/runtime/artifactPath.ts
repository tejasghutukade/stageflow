import path from "node:path";

/** Parts of a run-relative artifact path under `stages/.../artifacts/`. */
export type ArtifactPathParts = {
  stageId: string;
  attempt: number;
  relative: string;
};

export type ArtifactPathMode =
  | { kind: "grantable" }
  | { kind: "current_attempt"; stageId: string; attempt: number };

export function attemptArtifactsPrefix(stageId: string, attempt: number): string {
  return path.posix.join(
    "stages",
    stageId,
    "attempts",
    String(attempt),
    "artifacts",
  );
}

export function buildArtifactListedPath(parts: ArtifactPathParts): string {
  const relative = parts.relative.replace(/\\/g, "/");
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  return path.posix.join(
    "stages",
    parts.stageId,
    "attempts",
    String(parts.attempt),
    "artifacts",
    ...segments,
  );
}

function parseStrictGrantable(listedPath: string): ArtifactPathParts | undefined {
  if (typeof listedPath !== "string" || listedPath.length === 0) return undefined;
  const posix = listedPath.replace(/\\/g, "/");
  if (path.isAbsolute(listedPath) || path.posix.isAbsolute(posix)) return undefined;
  if (posix.includes("\0") || posix.includes("..")) return undefined;
  const parts = posix.split("/").filter((part) => part.length > 0);
  if (parts.length < 6) return undefined;
  if (parts[0] !== "stages" || parts[2] !== "attempts" || parts[4] !== "artifacts") {
    return undefined;
  }
  const attemptRaw = parts[3]!;
  if (!/^\d+$/.test(attemptRaw)) return undefined;
  const attempt = Number(attemptRaw);
  if (!Number.isInteger(attempt) || attempt < 1) return undefined;
  const relative = parts.slice(5).join("/");
  if (relative.length === 0) return undefined;
  return {
    stageId: parts[1]!,
    attempt,
    relative,
  };
}

/**
 * Accept a listed artifact path under a mode.
 * - `grantable`: full run-relative path to a prior stage/attempt artifact file.
 * - `current_attempt`: that attempt's run-relative prefix, or a bare path under
 *   its artifacts dir; foreign `stages/...` paths are rejected.
 */
export function acceptArtifactListedPath(
  listedPath: string,
  mode: ArtifactPathMode,
): ArtifactPathParts | undefined {
  if (mode.kind === "grantable") {
    return parseStrictGrantable(listedPath);
  }

  if (typeof listedPath !== "string" || listedPath.length === 0) {
    return undefined;
  }
  const posixListed = listedPath.replace(/\\/g, "/");
  if (path.isAbsolute(listedPath) || path.posix.isAbsolute(posixListed)) {
    return undefined;
  }

  const prefix = attemptArtifactsPrefix(mode.stageId, mode.attempt);
  if (posixListed === prefix || posixListed === `${prefix}/`) {
    return undefined;
  }
  if (posixListed.startsWith(`${prefix}/`)) {
    const relative = posixListed.slice(prefix.length + 1);
    if (relative.length === 0) return undefined;
    return {
      stageId: mode.stageId,
      attempt: mode.attempt,
      relative,
    };
  }
  if (posixListed.startsWith("stages/")) {
    return undefined;
  }
  return {
    stageId: mode.stageId,
    attempt: mode.attempt,
    relative: posixListed,
  };
}

export function parseArtifactListedPath(
  listedPath: string,
): ArtifactPathParts | undefined {
  return parseStrictGrantable(listedPath);
}

export function isGrantableArtifactPath(listedPath: string): boolean {
  return acceptArtifactListedPath(listedPath, { kind: "grantable" }) !== undefined;
}
