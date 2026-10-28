import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

export type ArtifactDiskFileType =
  | "file"
  | "directory"
  | "symlink"
  | "other"
  | "missing";

export type ArtifactDiskPresence = {
  file_type: ArtifactDiskFileType;
  /** Lexical absolute path under root when the walk reached a leaf. */
  absolutePath?: string;
  /** From lstat when `file_type` is `file`. */
  size_bytes?: number;
};

/**
 * Closed-posture walk of `relativePath` under `rootDir`: lstat every segment,
 * classify symlink / missing / file / directory / other. Does not follow
 * symlinks. Escape attempts are `missing`. Non-ENOENT errors propagate.
 */
export async function inspectArtifactUnderRoot(
  rootDir: string,
  relativePath: string,
): Promise<ArtifactDiskPresence> {
  const target = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { file_type: "missing" };
  }

  try {
    const segments = relative.split(path.sep).filter((segment) => segment !== "");
    let current = rootDir;
    let stats: Stats | undefined;
    for (const segment of segments) {
      current = path.join(current, segment);
      stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        return { file_type: "symlink", absolutePath: current };
      }
      if (current !== target && !stats.isDirectory()) {
        return { file_type: "other", absolutePath: current };
      }
    }
    if (stats === undefined) {
      return { file_type: "missing" };
    }
    if (stats.isDirectory()) {
      return { file_type: "directory", absolutePath: current };
    }
    if (!stats.isFile()) {
      return { file_type: "other", absolutePath: current };
    }
    return {
      file_type: "file",
      absolutePath: current,
      size_bytes: stats.size,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { file_type: "missing" };
    }
    throw error;
  }
}
