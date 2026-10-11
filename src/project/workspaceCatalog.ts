import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "./globalHome.js";

export const WORKSPACE_CATALOG_ID = "workspace";

export type WorkspaceProvisionResult = {
  path: string;
  ok: boolean;
  reason?: string;
};

let lastProvisionResult: WorkspaceProvisionResult | undefined;

export function resetWorkspaceProvisionForTests(): void {
  lastProvisionResult = undefined;
}

export function lastWorkspaceProvisionResult(): WorkspaceProvisionResult | undefined {
  return lastProvisionResult;
}

export function workspaceCatalogPath(home?: string): string {
  return path.join(home ?? globalStageflowHome(), "workspace");
}

function workspaceManifestYaml(): string {
  return `version: 1
catalog:
  pipelines:
    - .
  tasks:
    - .
  triggers:
    - .
  patterns:
    pipeline: "*.pipeline.yaml"
    task: "*.task.yaml"
    trigger: "*.trigger.yaml"
`;
}

function workspaceNotWritableReason(resolvedPath: string): string {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  return `Workspace catalog is not writable (${resolvedPath}). Running as uid=${uid} gid=${gid}. Try: sudo chown -R ${uid}:${gid} ${path.dirname(resolvedPath)}`;
}

function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      try {
        accessSync(parent, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function ensureWorkspaceCatalog(home?: string): WorkspaceProvisionResult {
  const wsPath = workspaceCatalogPath(home);
  if (!isWritableDir(wsPath)) {
    const result: WorkspaceProvisionResult = {
      path: wsPath,
      ok: false,
      reason: workspaceNotWritableReason(wsPath),
    };
    lastProvisionResult = result;
    return result;
  }
  try {
    mkdirSync(wsPath, { recursive: true });
    const manifestPath = path.join(wsPath, "stageflow.yaml");
    try {
      accessSync(manifestPath, constants.F_OK);
    } catch {
      writeFileSync(manifestPath, workspaceManifestYaml(), "utf8");
    }
    const result: WorkspaceProvisionResult = { path: wsPath, ok: true };
    lastProvisionResult = result;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: WorkspaceProvisionResult = {
      path: wsPath,
      ok: false,
      reason: `${workspaceNotWritableReason(wsPath)} (${message})`,
    };
    lastProvisionResult = result;
    return result;
  }
}
