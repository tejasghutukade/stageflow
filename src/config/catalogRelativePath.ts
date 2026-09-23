import path from "node:path";
import { realpathSync } from "node:fs";
import type { CatalogRoot } from "./resolveCatalogRoots.js";
import { findCatalogRoot } from "./resolveCatalogRoots.js";

export type CatalogPathErrorCode =
  | "absolute_path_not_allowed"
  | "path_outside_project_root"
  | "unknown_project_root";

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
    throw new CatalogPathError(
      `Absolute ${field} is not allowed on network surfaces; use a catalog-relative path under a registered project_root, or an inline definition.`,
      "absolute_path_not_allowed",
      registered,
    );
  }

  let root: CatalogRoot | undefined;
  if (input.projectRoot !== undefined) {
    root = findCatalogRoot(input.roots, input.projectRoot);
    if (root === undefined) {
      if (path.isAbsolute(input.projectRoot)) {
        const abs = realOrResolve(input.projectRoot);
        root = {
          project_root: abs,
          path: abs,
          kind: "registered",
          read_only: false,
        };
      } else {
        throw new CatalogPathError(
          `Unknown project_root: ${input.projectRoot}`,
          "unknown_project_root",
          registered,
        );
      }
    }
  } else if (input.roots.length === 1) {
    root = input.roots[0];
  } else {
    const boot = input.roots.find((r) => r.kind === "boot");
    root = boot ?? input.roots[0];
  }
  if (root === undefined) {
    throw new CatalogPathError(
      `No catalog roots available to resolve ${field}`,
      "unknown_project_root",
      registered,
    );
  }

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
} {
  return {
    error: err.message,
    code: err.code,
    registered_roots: err.registered_roots,
  };
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
