import { accessSync, constants } from "node:fs";
import { workspaceCatalogPath } from "../project/workspaceCatalog.js";

/**
 * Where agents live when no project is named: the Host's own project, or the workspace catalog
 * when that directory is not writable (a container runs from a read-only install dir).
 */
export function defaultAgentProjectRoot(cwd: string): string {
  try {
    accessSync(cwd, constants.W_OK);
    return cwd;
  } catch {
    return workspaceCatalogPath();
  }
}
