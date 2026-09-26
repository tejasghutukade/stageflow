import path from "node:path";
import { realpathSync } from "node:fs";
import type { CatalogRoot, ResolveCatalogRootsOptions } from "./resolveCatalogRoots.js";
import { findCatalogRoot, resolveCatalogRoots } from "./resolveCatalogRoots.js";

export type CatalogPathErrorCode =
  | "absolute_path_not_allowed"
  | "path_outside_project_root"
  | "unknown_project_root"
  | "catalog_root_read_only";

export class CatalogPathError extends Error {
  readonly code: CatalogPathErrorCode;
  readonly registered_roots: string[];

  constructor(
    message: string,
    code: CatalogPathErrorCode,
    registered_roots: string[],
  ) {
    super(message);
    this.name = "CatalogPathError";
    this.code = code;
    this.registered_roots = registered_roots;
  }
}

function realOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isInsideProjectRoot(projectRoot: string, candidate: string): boolean {
  const rootReal = realOrResolve(projectRoot);
  const candidateReal = realOrResolve(candidate);
  const rel = path.relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type ResolveCatalogRelativePathInput = {
  /** Caller-supplied path (pipeline, task, etc.). */
  inputPath: string;
  /** Optional wire project_root (symbolic seeded id or absolute). */
  projectRoot?: string;
  roots: CatalogRoot[];
  fieldName?: string;
};

export type ResolvedCatalogPath = {
  absolutePath: string;
  root: CatalogRoot;
  relativePath: string;
};

/**
 * Network-surface path contract: refuse absolute paths; resolve relative under
 * a selected catalog root; refuse `..` escape via realpath containment.
 */
export function resolveCatalogRelativePath(
  input: ResolveCatalogRelativePathInput,
): ResolvedCatalogPath {
  const field = input.fieldName ?? "path";
  const registered = input.roots.map((r) => r.project_root);

  if (path.isAbsolute(input.inputPath)) {
    const rootsList =
      registered.length > 0
        ? registered.join(", ")
        : "(none — register a project or use seeded examples)";
    throw new CatalogPathError(
      `Absolute ${field} is not allowed on network surfaces. Use a catalog-relative path under project_root (registered or seeded roots: ${rootsList}). Local CLI may pass absolute paths and auto-registers the project folder.`,
      "absolute_path_not_allowed",
      registered,
    );
  }

  const root = selectCatalogRootForStart(input.roots, input.projectRoot);

  const absolutePath = path.resolve(root.path, input.inputPath);
  if (!isInsideProjectRoot(root.path, absolutePath)) {
    throw new CatalogPathError(
      `${field} escapes project_root ${root.project_root}`,
      "path_outside_project_root",
      registered,
    );
  }

  return {
    absolutePath,
    root,
    relativePath: path.relative(root.path, absolutePath).replace(/\\/g, "/"),
  };
}

export function catalogPathErrorBody(err: CatalogPathError): {
  error: string;
  code: CatalogPathErrorCode;
  registered_roots: string[];
  hint?: string;
} {
  const body: {
    error: string;
    code: CatalogPathErrorCode;
    registered_roots: string[];
    hint?: string;
  } = {
    error: err.message,
    code: err.code,
    registered_roots: err.registered_roots,
  };
  if (err.code === "absolute_path_not_allowed") {
    body.hint =
      "MCP/HTTP: relative path under project_root; CLI may pass absolute paths and auto-register.";
  }
  return body;
}

/**
 * Pick the catalog root for start_run / POST /api/runs.
 * Wire project_root (symbolic seeded id or absolute) maps to CatalogRoot.path
 * (absolute store key). When omitted: sole root, or sole non-seeded root;
 * otherwise require explicit — no invent.
 */
export function selectCatalogRootForStart(
  roots: CatalogRoot[],
  projectRoot?: string,
): CatalogRoot {
  const registered = roots.map((r) => r.project_root);
  if (projectRoot !== undefined) {
    const found = findCatalogRoot(roots, projectRoot);
    if (found === undefined) {
      throw new CatalogPathError(
        `Unknown project_root: ${projectRoot}`,
        "unknown_project_root",
        registered,
      );
    }
    return found;
  }
  if (roots.length === 0) {
    throw new CatalogPathError(
      "No catalog roots configured; ensure a project_root first",
      "unknown_project_root",
      registered,
    );
  }
  if (roots.length === 1) {
    return roots[0]!;
  }
  const writable = roots.filter((r) => r.kind !== "seeded");
  if (writable.length === 1) {
    return writable[0]!;
  }
  throw new CatalogPathError(
    "project_root is required when multiple catalog roots are configured",
    "unknown_project_root",
    registered,
  );
}

/**
 * Shared helper: resolveCatalogRoots → selectCatalogRootForStart.
 * All network-surface start-input call sites use this to avoid the hand-copy sequence.
 */
export async function resolveCatalogStartInput(
  options: ResolveCatalogRootsOptions,
  projectRoot?: string,
): Promise<{ roots: CatalogRoot[]; wireRoot: CatalogRoot }> {
  const roots = await resolveCatalogRoots(options);
  const wireRoot = selectCatalogRootForStart(roots, projectRoot);
  return { roots, wireRoot };
}

/**
 * Like resolveCatalogStartInput but additionally refuses read-only roots.
 * Used by write surfaces (POST /api/stages, POST /api/pipelines).
 */
export async function resolveWritableCatalogRoot(
  options: ResolveCatalogRootsOptions,
  projectRoot?: string,
): Promise<{ roots: CatalogRoot[]; wireRoot: CatalogRoot }> {
  const { roots, wireRoot } = await resolveCatalogStartInput(options, projectRoot);
  if (wireRoot.read_only) {
    throw new CatalogPathError(
      `Catalog root ${wireRoot.project_root} is read-only`,
      "catalog_root_read_only",
      roots.map((r) => r.project_root),
    );
  }
  return { roots, wireRoot };
}

/**
 * Local CLI control: turn a cwd-resolved filesystem path into a catalog-relative
 * wire path + project_root so the network surface does not see an absolute path.
 */
export function relativizeLocalPathForNetwork(
  cwd: string,
  inputPath: string,
): { path: string; project_root: string } {
  const abs = realOrResolve(path.resolve(cwd, inputPath));
  const cwdAbs = realOrResolve(cwd);
  const rel = path.relative(cwdAbs, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path ${abs} is outside CLI cwd ${cwdAbs}; run from the project root, pass a path under cwd, or use an inline definition on the Host API`,
    );
  }
  return {
    path: rel === "" ? "." : rel.replace(/\\/g, "/"),
    project_root: cwdAbs,
  };
}
