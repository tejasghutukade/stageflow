import { randomBytes } from "node:crypto";
import { readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import { guardStageId } from "./workspaceLayout.js";

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Root for factory state under a project: `<rootDir>/.stageflow`. */
export function storeRootFor(rootDir: string): string {
  return path.join(rootDir, ".stageflow");
}

function directoryState(
  dirPath: string,
): "missing" | "empty" | "populated" | "other" {
  try {
    const st = statSync(dirPath);
    if (!st.isDirectory()) return "other";
    return readdirSync(dirPath).length === 0 ? "empty" : "populated";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

export function migrateLegacyStoreRoot(rootDir: string): void {
  const newPath = storeRootFor(rootDir);
  const oldPath = path.join(rootDir, ".software-factory");
  const newState = directoryState(newPath);
  if (newState === "populated") {
    return;
  }
  const oldState = directoryState(oldPath);
  if (oldState !== "empty" && oldState !== "populated") {
    return;
  }
  if (newState === "empty") {
    rmdirSync(newPath);
  }
  try {
    renameSync(oldPath, newPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" &&
      directoryState(oldPath) === "missing" &&
      directoryState(newPath) === "populated"
    ) {
      return;
    }
    throw err;
  }
}

export function runsDir(storeRoot: string): string {
  return path.join(storeRoot, "runs");
}

export function runWorkspaceDir(storeRoot: string, runId: string): string {
  return path.join(runsDir(storeRoot), runId);
}

export function stageDir(workspaceDir: string, stageId: string): string {
  guardStageId(stageId);
  return path.join(workspaceDir, "stages", stageId);
}
