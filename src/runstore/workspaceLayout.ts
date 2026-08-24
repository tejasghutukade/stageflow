import { access, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export { stageDir } from "./paths.js";

function guardStageId(stageId: string): void {
  if (
    stageId.includes("..") ||
    stageId.includes("/") ||
    stageId.includes("\\")
  ) {
    throw new Error("stageId must not contain path separators or ..");
  }
}

function guardAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
}

export function attemptWorkspaceDir(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  guardStageId(stageId);
  guardAttempt(attempt);
  return path.join(
    workspaceDir,
    "stages",
    stageId,
    "attempts",
    String(attempt),
  );
}

export function attemptLogPath(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return path.join(attemptWorkspaceDir(workspaceDir, stageId, attempt), "log.jsonl");
}

export function attemptEnvelopePath(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return path.join(
    attemptWorkspaceDir(workspaceDir, stageId, attempt),
    "envelope.json",
  );
}

export function attemptArtifactsDir(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return path.join(
    attemptWorkspaceDir(workspaceDir, stageId, attempt),
    "artifacts",
  );
}

export function attemptAgentDir(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return path.join(
    attemptWorkspaceDir(workspaceDir, stageId, attempt),
    ".pi-agent",
  );
}

export function attemptSessionPath(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): string {
  return path.join(
    attemptWorkspaceDir(workspaceDir, stageId, attempt),
    "pi-session.jsonl",
  );
}

/** @deprecated Use attemptArtifactsDir with an explicit attempt number. */
export function artifactsDir(workspaceDir: string, stageId: string): string {
  return attemptArtifactsDir(workspaceDir, stageId, 1);
}

/** @deprecated Use attemptAgentDir with an explicit attempt number. */
export function agentDir(workspaceDir: string, stageId: string): string {
  return attemptAgentDir(workspaceDir, stageId, 1);
}

/** @deprecated Use attemptEnvelopePath with an explicit attempt number. */
export function envelopePath(workspaceDir: string, stageId: string): string {
  return attemptEnvelopePath(workspaceDir, stageId, 1);
}

/** @deprecated Use attemptLogPath with an explicit attempt number. */
export function stageLogPath(workspaceDir: string, stageId: string): string {
  return attemptLogPath(workspaceDir, stageId, 1);
}

/** @deprecated Use attemptSessionPath with an explicit attempt number. */
export function stageSessionPath(workspaceDir: string, stageId: string): string {
  return attemptSessionPath(workspaceDir, stageId, 1);
}

export function isInsideDir(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function resolveArtifactTarget(
  runWorkspaceDir: string,
  stageId: string,
  attempt: number,
  relativePath: string,
): { absolutePath: string; runRelativePath: string; artifactsDir: string } {
  guardStageId(stageId);
  guardAttempt(attempt);
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("path must be relative to the stage artifacts directory");
  }

  const artifacts = path.resolve(
    attemptArtifactsDir(runWorkspaceDir, stageId, attempt),
  );
  const resolved = path.resolve(artifacts, relativePath);
  const relativeToArtifacts = path.relative(artifacts, resolved);
  if (relativeToArtifacts === "") {
    throw new Error("path must name a file under the stage artifacts directory");
  }
  if (
    relativeToArtifacts === ".." ||
    relativeToArtifacts.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToArtifacts)
  ) {
    throw new Error("path escapes the stage artifacts directory");
  }

  const runRelativePath = path.posix.join(
    "stages",
    stageId,
    "attempts",
    String(attempt),
    "artifacts",
    ...relativeToArtifacts.split(path.sep),
  );
  return {
    absolutePath: resolved,
    runRelativePath,
    artifactsDir: artifacts,
  };
}

export async function ensureRealArtifactsDir(
  runWorkspaceDir: string,
  artifactsDirectory: string,
): Promise<{ realRun: string; realArtifacts: string }> {
  await mkdir(artifactsDirectory, { recursive: true });
  const realRun = await realpath(runWorkspaceDir);
  const realArtifacts = await realpath(artifactsDirectory);
  if (!isInsideDir(realArtifacts, realRun)) {
    throw new Error("path escapes the stage artifacts directory");
  }
  return { realRun, realArtifacts };
}

export async function resolveContainedParent(
  realArtifacts: string,
  relativeToArtifacts: string,
): Promise<string> {
  const segments = relativeToArtifacts.split(path.sep).filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error("path must name a file under the stage artifacts directory");
  }
  const dirSegments = segments.slice(0, -1);
  let current = realArtifacts;
  for (const segment of dirSegments) {
    const next = path.join(current, segment);
    try {
      const st = await lstat(next);
      if (st.isSymbolicLink()) {
        throw new Error("path escapes the stage artifacts directory");
      }
      if (!st.isDirectory()) {
        throw new Error("path escapes the stage artifacts directory");
      }
      current = await realpath(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      await mkdir(next);
      current = next;
    }
    if (!isInsideDir(current, realArtifacts)) {
      throw new Error("path escapes the stage artifacts directory");
    }
  }
  return current;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkArtifactFiles(
  dir: string,
  runRelativePrefix: string[],
  relativeParts: string[],
  out: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const nextParts = [...relativeParts, entry.name];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkArtifactFiles(full, runRelativePrefix, nextParts, out);
    } else if (entry.isFile()) {
      out.push(path.posix.join(...runRelativePrefix, ...nextParts));
    }
  }
}

/** Legacy stage-root artifacts dir (pre-uniform unbound writes); kept for reads. */
export function stageArtifactsDir(
  workspaceDir: string,
  stageId: string,
): string {
  guardStageId(stageId);
  return path.join(workspaceDir, "stages", stageId, "artifacts");
}

export async function listArtifactNames(
  workspaceDir: string,
  stageId: string,
  attempt: number,
): Promise<string[]> {
  guardStageId(stageId);
  guardAttempt(attempt);
  const out: string[] = [];

  const attemptDir = attemptArtifactsDir(workspaceDir, stageId, attempt);
  if (await fileExists(attemptDir)) {
    await walkArtifactFiles(
      attemptDir,
      ["stages", stageId, "attempts", String(attempt), "artifacts"],
      [],
      out,
    );
  }

  const stageDirPath = stageArtifactsDir(workspaceDir, stageId);
  if (await fileExists(stageDirPath)) {
    await walkArtifactFiles(
      stageDirPath,
      ["stages", stageId, "artifacts"],
      [],
      out,
    );
  }

  out.sort();
  return out;
}
