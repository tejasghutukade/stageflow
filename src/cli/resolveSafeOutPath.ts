import { realpathSync } from "node:fs";
import path from "node:path";
import { isInsideDir } from "../runstore/workspaceLayout.js";

function resolveEffectiveRealPathSync(candidatePath: string): string {
  try {
    return realpathSync(candidatePath);
  } catch {
    const missing: string[] = [];
    let current = candidatePath;
    while (true) {
      missing.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(candidatePath);
      }
      try {
        const realParent = realpathSync(parent);
        return path.join(realParent, ...missing);
      } catch {
        current = parent;
      }
    }
  }
}

/** Resolve `--out` under cwd, realpath-normalizing both sides before containment. */
export function resolveSafeOutPath(outPath: string, cwd: string): string {
  const segments = outPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("path must not contain .. segments");
  }
  const resolved = path.resolve(cwd, outPath);
  const cwdResolved = resolveEffectiveRealPathSync(path.resolve(cwd));
  const outResolved = resolveEffectiveRealPathSync(resolved);
  if (!isInsideDir(outResolved, cwdResolved)) {
    throw new Error(
      "output path must resolve under the current working directory",
    );
  }
  return resolved;
}
