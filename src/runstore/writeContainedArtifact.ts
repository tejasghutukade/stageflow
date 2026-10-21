/**
 * Atomic write of one file under a stage attempt's artifacts directory.
 * Refuses symlinked or hard-linked targets and any path that resolves outside
 * the artifacts directory.
 */
import { randomBytes } from "node:crypto";
import { lstat, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureRealArtifactsDir,
  isInsideDir,
  resolveContainedParent,
} from "./workspaceLayout.js";

async function assertSafeWriteTarget(targetPath: string): Promise<void> {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) {
      throw new Error("path escapes the stage artifacts directory");
    }
    if (st.nlink > 1) {
      throw new Error("refusing to overwrite hard-linked file");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export async function writeContainedArtifact(
  runWorkspaceDir: string,
  artifactsDirectory: string,
  absolutePath: string,
  content: string,
): Promise<void> {
  const { realArtifacts } = await ensureRealArtifactsDir(
    runWorkspaceDir,
    artifactsDirectory,
  );
  const relativeToArtifacts = path.relative(artifactsDirectory, absolutePath);
  const parent = await resolveContainedParent(
    realArtifacts,
    relativeToArtifacts,
  );
  const baseName = path.basename(absolutePath);
  const targetPath = path.join(parent, baseName);
  await assertSafeWriteTarget(targetPath);

  const tmpName = `.sf-artifact-${randomBytes(8).toString("hex")}.tmp`;
  const tmpPath = path.join(parent, tmpName);
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  const realWritten = await realpath(targetPath);
  if (!isInsideDir(realWritten, realArtifacts)) {
    throw new Error("path escapes the stage artifacts directory");
  }
}
