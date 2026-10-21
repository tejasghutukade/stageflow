import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunStore } from "../runstore/port.js";
import { classifyRealPathContainment } from "../runstore/workspaceLayout.js";

export function assertSafeRunId(runId: string): void {
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

export const PATH_DENIED_MESSAGE = "Artifact path denied";

export type ContainedPathMessages = {
  relativeRequired: string;
  escapes: string;
  notFound: (relativePath: string) => string;
  denied?: string;
};

const ARTIFACT_MESSAGES: ContainedPathMessages = {
  relativeRequired: "path must be relative to the run workspace",
  escapes: "path escapes the run workspace",
  notFound: (relativePath) => `Artifact not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

export const CHECKOUT_PATH_MESSAGES: ContainedPathMessages = {
  relativeRequired: "path must be relative to the checkout",
  escapes: "path escapes the checkout",
  notFound: (relativePath) => `Checkout file not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

export function assertSafeRelativePath(
  relativePath: string,
  messages: ContainedPathMessages,
): string[] {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(messages.relativeRequired);
  }
  const segments = relativePath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("path must not contain .. segments");
  }
  if (
    segments.some((segment) => segment === ".pi-agent") ||
    path.basename(relativePath) === "auth.json"
  ) {
    throw new Error(messages.denied ?? PATH_DENIED_MESSAGE);
  }
  return segments;
}

export async function resolveContainedRelativePath(
  containerDir: string,
  relativePath: string,
  messages: ContainedPathMessages,
): Promise<string> {
  assertSafeRelativePath(relativePath, messages);
  const candidate = path.resolve(containerDir, relativePath);
  const containment = await classifyRealPathContainment(candidate, containerDir);
  if (containment.status === "missing") {
    throw new Error(messages.notFound(relativePath));
  }
  if (containment.status === "outside") {
    throw new Error(messages.escapes);
  }
  return containment.realPath;
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

export type ClassifiedArtifactContent =
  | { kind: "image"; mimeType: string }
  | { kind: "utf8" }
  | { kind: "binary" };

export function classifyArtifactContent(
  relativePath: string,
  bytes: Buffer,
): ClassifiedArtifactContent {
  const mimeType = artifactMediaType(relativePath);
  if (mimeType !== undefined) {
    return { kind: "image", mimeType };
  }
  if (isUtf8(bytes)) {
    return { kind: "utf8" };
  }
  return { kind: "binary" };
}

async function resolveRunArtifactFile(
  store: RunStore,
  runId: string,
  relativePath: string,
): Promise<string> {
  assertSafeRunId(runId);
  await store.readRunMeta(runId);
  const workspaceDir = store.getWorkspaceDir(runId);
  return resolveContainedRelativePath(workspaceDir, relativePath, ARTIFACT_MESSAGES);
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
