import { realpathSync } from "node:fs";
import path from "node:path";

export type ProjectRef = { id?: string; path?: string };

function realOrResolve(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Does a stored project identifier refer to this project?
 * A stored value is a symbolic wire id (such as `workspace`) or an absolute path.
 * It matches the project's wire id exactly, or its path after resolving
 * (and, when both exist on disk, after realpath).
 */
export function storedProjectMatches(stored: string, project: ProjectRef): boolean {
  if (project.id !== undefined && stored === project.id) return true;
  if (project.path === undefined) return false;
  if (stored === project.path) return true;
  const a = path.resolve(stored);
  const b = path.resolve(project.path);
  if (a === b) return true;
  return realOrResolve(a) === realOrResolve(b);
}
