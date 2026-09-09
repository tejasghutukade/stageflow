import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { RunStore } from "../runstore/port.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";

function assertSafeRunId(runId: string): void {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error("runId must be a non-empty string");
  }
  if (
    runId.includes("..") ||
    runId.includes("/") ||
    runId.includes("\\") ||
    path.isAbsolute(runId)
  ) {
    throw new Error("runId must not contain path separators or ..");
  }
}

export function artifactMediaType(relativePath: string): string | undefined {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

async function resolveRunArtifactFile(
  store: RunStore,
  runId: string,
  relativePath: string,
): Promise<string> {
  assertSafeRunId(runId);
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("path must be relative to the run workspace");
  }
  const segments = relativePath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("path must not contain .. segments");
  }
  if (
    segments.some((segment) => segment === ".pi-agent") ||
    path.basename(relativePath) === "auth.json"
  ) {
    throw new Error("Artifact path denied");
  }

  await store.readRunMeta(runId);

  const workspaceDir = store.getWorkspaceDir(runId);
  const workspaceReal = await realpath(workspaceDir);
  const candidate = path.resolve(workspaceDir, relativePath);
  let fileReal: string;
  try {
    fileReal = await realpath(candidate);
  } catch {
    throw new Error(`Artifact not found: ${relativePath}`);
  }

  if (!isInsideDir(fileReal, workspaceReal)) {
    throw new Error("path escapes the run workspace");
  }

  return fileReal;
}

export async function readRunArtifact(
  store: RunStore,
  runId: string,
  relativePath: string,
): Promise<string> {
  const fileReal = await resolveRunArtifactFile(store, runId, relativePath);
  return readFile(fileReal, "utf8");
}

export async function readRunArtifactBytes(
  store: RunStore,
  runId: string,
  relativePath: string,
): Promise<Buffer> {
  const fileReal = await resolveRunArtifactFile(store, runId, relativePath);
  return readFile(fileReal);
}
