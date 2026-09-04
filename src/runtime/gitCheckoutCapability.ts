import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import type {
  CheckoutCapability,
  CheckoutChange,
  CheckoutSnapshot,
} from "./completionCheckRunner.js";

type TrackedPath = { path: string; tracked: boolean };

function runGit(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr)
            ? stderr.toString("utf8").trim()
            : "";
          reject(new Error(detail || error.message));
          return;
        }
        resolve(stdout as Buffer);
      },
    );
  });
}

function nulPaths(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean);
}

async function fingerprintFile(root: string, relativePath: string): Promise<string> {
  const target = path.join(root, relativePath);
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      const targetPath = await readlink(target);
      return `link:${createHash("sha256").update(targetPath).digest("hex")}`;
    }
    if (!stats.isFile()) return `other:${stats.mode}:${stats.size}`;
    const contents = await readFile(target);
    return `file:${createHash("sha256").update(contents).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function filesAt(root: string): Promise<TrackedPath[]> {
  const [trackedOutput, untrackedOutput] = await Promise.all([
    runGit(root, ["ls-files", "-z"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const known = new Map<string, boolean>();
  for (const file of nulPaths(trackedOutput)) known.set(file, true);
  for (const file of nulPaths(untrackedOutput)) known.set(file, false);
  return [...known.entries()]
    .map(([file, tracked]) => ({ path: file, tracked }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function capture(root: string): Promise<CheckoutSnapshot> {
  const files = await filesAt(root);
  return {
    entries: await Promise.all(
      files.map(async ({ path: file, tracked }) => ({
        path: file,
        fingerprint: `${tracked ? "tracked" : "untracked"}:${await fingerprintFile(root, file)}`,
      })),
    ),
  };
}

function statusForAdded(fingerprint: string): CheckoutChange["status"] {
  return fingerprint.startsWith("untracked:") ? "untracked" : "added";
}

/**
 * Git-backed checkout observation. It fingerprints tracked and untracked
 * files before the agent runs, so pre-existing changes are not attributed to
 * the stage and content changes do not disappear behind a shared Git status.
 */
export function createGitCheckoutCapability(root: string): CheckoutCapability {
  return {
    capture: () => capture(root),
    async changesSince(before) {
      const after = await capture(root);
      const earlier = new Map(
        before.entries.map((entry) => [entry.path, entry.fingerprint]),
      );
      const later = new Map(
        after.entries.map((entry) => [entry.path, entry.fingerprint]),
      );
      const paths = [...new Set([...earlier.keys(), ...later.keys()])].sort();
      const changes: CheckoutChange[] = [];
      for (const file of paths) {
        const previous = earlier.get(file);
        const current = later.get(file);
        if (previous === undefined && current !== undefined) {
          changes.push({ path: file, status: statusForAdded(current) });
        } else if (previous !== undefined && current === undefined) {
          changes.push({ path: file, status: "deleted" });
        } else if (previous !== current) {
          changes.push({ path: file, status: "modified" });
        }
      }
      return changes;
    },
  };
}
