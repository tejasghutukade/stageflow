import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveWritableCatalogRoot } from "../config/catalogRelativePath.js";
import { CatalogPathError, catalogPathErrorBody } from "../config/catalogRelativePath.js";
import { findCatalogRoot, resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
import { hostBaseUrl } from "../server/ensureGlobalService.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

export type WriteTarget = {
  /** Absolute directory the tool writes into. */
  path: string;
  /** Wire id of the project: `workspace` for the Host workspace, an absolute path for a registered project. */
  project_root: string;
};

/**
 * The project a file-writing tool targets. A named project_root resolves against the Host's catalog roots (a path
 * outside them is still honored as given). With none, the Host's workspace is used, never the Host process cwd.
 */
export async function resolveWriteTarget(deps: McpToolDeps, projectRoot: string | undefined): Promise<WriteTarget> {
  const options = { store: deps.store, bootCwd: deps.cwd };
  if (projectRoot !== undefined) {
    const found = findCatalogRoot(await resolveCatalogRoots(options), projectRoot);
    if (found !== undefined) {
      const { wireRoot } = await resolveWritableCatalogRoot(options, projectRoot);
      return { path: wireRoot.path, project_root: wireRoot.project_root };
    }
    const resolved = path.resolve(projectRoot);
    const real = await realpath(resolved).catch(() => resolved);
    return { path: real, project_root: real };
  }
  const { wireRoot } = await resolveWritableCatalogRoot(options);
  return { path: wireRoot.path, project_root: wireRoot.project_root };
}

/**
 * Where a read-only tool looks. Unlike a write target it does not require a writable or available root, so a
 * read-only registered catalog stays readable. With no project_root it uses the Host workspace when that exists,
 * else the Host's own project (the earlier default).
 */
export async function resolveReadRoot(deps: McpToolDeps, projectRoot: string | undefined): Promise<string> {
  const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
  if (projectRoot !== undefined) {
    const found = findCatalogRoot(roots, projectRoot);
    if (found !== undefined) return found.path;
    const resolved = path.resolve(projectRoot);
    return realpath(resolved).catch(() => resolved);
  }
  const workspace = findCatalogRoot(roots, "workspace");
  if (workspace !== undefined && workspace.available !== false) return workspace.path;
  const resolved = path.resolve(deps.projectRoot ?? deps.cwd);
  return realpath(resolved).catch(() => resolved);
}

export function projectFields(target: WriteTarget): { project_root: string; project_path: string } {
  return { project_root: target.project_root, project_path: target.path };
}

/** Run a handler, answering a catalog root failure (unknown, read-only, workspace unavailable) as a tool error. */
export async function catching<T>(work: () => Promise<T>): Promise<T | ReturnType<typeof textResult>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CatalogPathError) return textResult(catalogPathErrorBody(error), true);
    throw error;
  }
}

/** Console base for this MCP session: the address the client reached the Host on, else the local Host. */
export function consoleBase(deps: McpToolDeps): string {
  return (deps.mcpToolsetSession?.baseUrl ?? hostBaseUrl()).replace(/\/+$/, "");
}

export function consoleUrl(deps: McpToolDeps, hashPath: string): string {
  return `${consoleBase(deps)}/#${hashPath}`;
}

export function runConsoleUrl(deps: McpToolDeps, runId: string): string {
  return consoleUrl(deps, `/runs/${encodeURIComponent(runId)}`);
}

export function pipelineConsoleUrl(deps: McpToolDeps, pipelineId: string, projectRoot: string): string {
  const query = projectRoot === "workspace" ? "" : `?${new URLSearchParams({ project_root: projectRoot })}`;
  return consoleUrl(deps, `/pipelines/${encodeURIComponent(pipelineId)}${query}`);
}

/** Name an absolute project directory the way the console and `project_root` arguments do. */
export async function targetForPath(deps: McpToolDeps, absPath: string): Promise<WriteTarget> {
  const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
  const found = findCatalogRoot(roots, absPath);
  return found !== undefined
    ? { path: found.path, project_root: found.project_root }
    : { path: absPath, project_root: absPath };
}

export function withProject<T>(result: T, target: WriteTarget, extra: Record<string, unknown> = {}): T {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  return { ...result, ...projectFields(target), ...extra };
}
