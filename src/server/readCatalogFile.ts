import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CatalogPathError,
  isInsideProjectRoot,
  resolveCatalogRelativePath,
  type ResolveCatalogRelativePathInput,
} from "../config/catalogRelativePath.js";
import { loadStageOutcome } from "../config/loadStage.js";
import {
  findingsFromLoadIssues,
  type ValidationFinding,
} from "../config/validateCatalog.js";

export const CATALOG_FILE_MAX_BYTES = 512 * 1024;

export type CatalogFileReadErrorCode =
  | "unsupported_file_type"
  | "path_outside_project_root"
  | "catalog_file_not_found"
  | "catalog_file_too_large";

export type ReadCatalogFileResult =
  | { ok: true; path: string; content: string }
  | {
      ok: false;
      status: 400 | 404 | 413;
      error: string;
      code: CatalogFileReadErrorCode;
    };

export type WriteCatalogFileResult =
  | { ok: true; path: string; content: string }
  | {
      ok: false;
      status: 400 | 404 | 413;
      error: string;
      code: CatalogFileReadErrorCode | "stage_invalid";
      findings?: ValidationFinding[];
    };

function isCatalogYamlExtension(inputPath: string): boolean {
  const ext = path.extname(inputPath).toLowerCase();
  return ext === ".yaml" || ext === ".yml";
}

export async function readCatalogFileForHttp(
  input: ResolveCatalogRelativePathInput,
): Promise<ReadCatalogFileResult> {
  if (!isCatalogYamlExtension(input.inputPath)) {
    return {
      ok: false,
      status: 400,
      error: "Only .yaml and .yml catalog files can be read",
      code: "unsupported_file_type",
    };
  }

  let resolved;
  try {
    resolved = resolveCatalogRelativePath(input);
  } catch (err) {
    if (err instanceof CatalogPathError) {
      if (err.code === "path_outside_project_root") {
        return {
          ok: false,
          status: 400,
          error: err.message,
          code: "path_outside_project_root",
        };
      }
      throw err;
    }
    throw err;
  }

  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = await realpath(resolved.root.path);
    fileReal = await realpath(resolved.absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        error: "Catalog file not found",
        code: "catalog_file_not_found",
      };
    }
    throw err;
  }

  if (!isInsideProjectRoot(rootReal, fileReal)) {
    return {
      ok: false,
      status: 400,
      error: `path escapes project_root ${resolved.root.project_root}`,
      code: "path_outside_project_root",
    };
  }

  if (!isCatalogYamlExtension(fileReal)) {
    return {
      ok: false,
      status: 400,
      error: "Only .yaml and .yml catalog files can be read",
      code: "unsupported_file_type",
    };
  }

  let fileStat;
  try {
    fileStat = await stat(fileReal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        error: "Catalog file not found",
        code: "catalog_file_not_found",
      };
    }
    throw err;
  }

  if (!fileStat.isFile()) {
    return {
      ok: false,
      status: 400,
      error: "Only .yaml and .yml catalog files can be read",
      code: "unsupported_file_type",
    };
  }

  if (fileStat.size > CATALOG_FILE_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Catalog file exceeds ${CATALOG_FILE_MAX_BYTES} byte limit`,
      code: "catalog_file_too_large",
    };
  }

  const content = await readFile(fileReal, "utf8");
  return { ok: true, path: resolved.relativePath, content };
}

export async function writeCatalogFileForHttp(
  input: ResolveCatalogRelativePathInput & { content: string },
): Promise<WriteCatalogFileResult> {
  if (!isCatalogYamlExtension(input.inputPath)) {
    return {
      ok: false,
      status: 400,
      error: "Only .yaml and .yml catalog files can be written",
      code: "unsupported_file_type",
    };
  }

  if (Buffer.byteLength(input.content, "utf8") > CATALOG_FILE_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Catalog file exceeds ${CATALOG_FILE_MAX_BYTES} byte limit`,
      code: "catalog_file_too_large",
    };
  }

  let resolved;
  try {
    resolved = resolveCatalogRelativePath(input);
  } catch (err) {
    if (err instanceof CatalogPathError) {
      if (err.code === "path_outside_project_root") {
        return {
          ok: false,
          status: 400,
          error: err.message,
          code: "path_outside_project_root",
        };
      }
      throw err;
    }
    throw err;
  }

  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = await realpath(resolved.root.path);
    fileReal = await realpath(resolved.absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        error: "Catalog file not found",
        code: "catalog_file_not_found",
      };
    }
    throw err;
  }

  if (!isInsideProjectRoot(rootReal, fileReal)) {
    return {
      ok: false,
      status: 400,
      error: `path escapes project_root ${resolved.root.project_root}`,
      code: "path_outside_project_root",
    };
  }

  if (!isCatalogYamlExtension(fileReal)) {
    return {
      ok: false,
      status: 400,
      error: "Only .yaml and .yml catalog files can be written",
      code: "unsupported_file_type",
    };
  }

  let fileStat;
  try {
    fileStat = await stat(fileReal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        error: "Catalog file not found",
        code: "catalog_file_not_found",
      };
    }
    throw err;
  }

  if (!fileStat.isFile()) {
    return {
      ok: false,
      status: 400,
      error: "Only .yaml and .yml catalog files can be written",
      code: "unsupported_file_type",
    };
  }

  const original = await readFile(fileReal, "utf8");
  await writeFile(fileReal, input.content, "utf8");

  const outcome = await loadStageOutcome(fileReal);
  if (!outcome.ok) {
    await writeFile(fileReal, original, "utf8");
    const findings = findingsFromLoadIssues(
      resolved.root.path,
      fileReal,
      outcome.issues,
    );
    return {
      ok: false,
      status: 400,
      error: findings[0]?.message ?? "Invalid stage YAML",
      code: "stage_invalid",
      findings,
    };
  }

  return { ok: true, path: resolved.relativePath, content: input.content };
}
