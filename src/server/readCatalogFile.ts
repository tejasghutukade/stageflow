import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import {
  CatalogPathError,
  isInsideProjectRoot,
  resolveCatalogRelativePath,
  type ResolveCatalogRelativePathInput,
} from "../config/catalogRelativePath.js";
import { loadFailure, type LoadOutcome } from "../config/loadOutcome.js";
import { contentHash, writeFileAtomic } from "../config/atomicWrite.js";
import { renderCatalogYaml } from "../config/preserveCatalogYaml.js";
import { loadPipelineOutcome } from "../config/loadPipeline.js";
import { loadStageOutcome } from "../config/loadStage.js";
import { loadStageflowManifestOutcome } from "../config/loadStageflowManifest.js";
import { loadTaskOutcome } from "../config/loadTask.js";
import { loadTriggerOutcome } from "../config/loadTrigger.js";
import { isFunctionDefinitionFile } from "../config/loadFunction.js";
import { STAGE_FILENAME_SUFFIXES } from "../config/stageFilenameStem.js";
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

export type CatalogFileWriteInvalidCode =
  | "stage_invalid"
  | "pipeline_invalid"
  | "task_invalid"
  | "trigger_invalid"
  | "manifest_invalid"
  | "function_invalid";

export type WriteCatalogFileErrorCode =
  | CatalogFileReadErrorCode
  | CatalogFileWriteInvalidCode
  | "catalog_file_exists"
  | "use_eval_api"
  | "use_function_api"
  | "FILE_CHANGED";

export type WriteCatalogFileResult =
  | { ok: true; path: string; content: string; hash: string }
  | {
      ok: false;
      status: 400 | 404 | 409 | 413;
      error: string;
      code: WriteCatalogFileErrorCode;
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

export type CatalogFileKind = "stage" | "pipeline" | "task" | "trigger" | "manifest" | "function";

const INVALID_CODE: Record<CatalogFileKind, CatalogFileWriteInvalidCode> = {
  stage: "stage_invalid",
  pipeline: "pipeline_invalid",
  task: "task_invalid",
  trigger: "trigger_invalid",
  manifest: "manifest_invalid",
  function: "function_invalid",
};

/** Eval and dataset files have their own write path (base hash, atomic write); this route refuses them. */
function isEvalCatalogFile(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  return /\.eval\.ya?ml$/.test(base) || /\.dataset\.(jsonl|json|csv)$/.test(base);
}

/** What the file is, from its name first and then its content; an unrecognized file is checked as a stage, as before. */
export function catalogFileKind(relativePath: string, content: string): CatalogFileKind {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalized === "stageflow.yaml") return "manifest";
  const base = path.basename(normalized).toLowerCase();
  if (base.endsWith(".pipeline.yaml") || base.endsWith(".pipeline.yml")) return "pipeline";
  if (base.endsWith(".task.yaml") || base.endsWith(".task.yml")) return "task";
  if (base.endsWith(".trigger.yaml") || base.endsWith(".trigger.yml")) return "trigger";
  if (isFunctionDefinitionFile(base)) return "function";
  if (STAGE_FILENAME_SUFFIXES.some((suffix) => base.endsWith(suffix))) return "stage";
  if ((base.endsWith(".js") || base.endsWith(".ts")) && !isFunctionDefinitionFile(base)) return "manifest";
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch {
    return "stage";
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "stage";
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.stages) || record.include !== undefined) return "pipeline";
  if (typeof record.goal === "string" && record.system_prompt === undefined) return "task";
  return "stage";
}

async function loadCatalogFileOutcome(kind: CatalogFileKind, file: string, root: string): Promise<LoadOutcome<unknown>> {
  switch (kind) {
    case "pipeline":
      return loadPipelineOutcome(file, { cwd: root, projectRoot: root });
    case "task":
      return loadTaskOutcome(file);
    case "trigger":
      return loadTriggerOutcome(file);
    case "manifest":
      return loadStageflowManifestOutcome(root);
    case "stage":
      return loadStageOutcome(file);
    case "function":
      return loadFailure([
        {
          code: "function.invalid",
          message: "Function files are written through the functions API",
          category: "catalog",
        },
      ]);
  }
}

/** The nearest folder of `target` that exists, so a new file's real location can be checked before anything is created. */
async function nearestExistingDir(target: string): Promise<string> {
  let dir = path.dirname(target);
  for (;;) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

function writeFailure(status: 400 | 404 | 409 | 413, error: string, code: WriteCatalogFileErrorCode): WriteCatalogFileResult {
  return { ok: false, status, error, code };
}

/**
 * `baseHash`: refuse with FILE_CHANGED when the file on disk is no longer the one the editor opened.
 * `preserveFormatting`: apply `content` onto the existing file so comments, quoting and untouched lines stay.
 */
export async function writeCatalogFileForHttp(
  input: ResolveCatalogRelativePathInput & {
    content: string;
    create?: boolean;
    baseHash?: string;
    preserveFormatting?: boolean;
  },
): Promise<WriteCatalogFileResult> {
  if (isFunctionDefinitionFile(path.basename(input.inputPath))) {
    return writeFailure(400, "Function files are written through the functions API", "use_function_api");
  }
  if (!isCatalogYamlExtension(input.inputPath)) {
    return writeFailure(400, "Only .yaml and .yml catalog files can be written", "unsupported_file_type");
  }
  if (isEvalCatalogFile(input.inputPath)) {
    return writeFailure(400, "Eval files are written through the evals API", "use_eval_api");
  }
  if (Buffer.byteLength(input.content, "utf8") > CATALOG_FILE_MAX_BYTES) {
    return writeFailure(413, `Catalog file exceeds ${CATALOG_FILE_MAX_BYTES} byte limit`, "catalog_file_too_large");
  }

  let resolved;
  try {
    resolved = resolveCatalogRelativePath(input);
  } catch (err) {
    if (err instanceof CatalogPathError && err.code === "path_outside_project_root") {
      return writeFailure(400, err.message, "path_outside_project_root");
    }
    throw err;
  }

  const rootReal = await realpath(resolved.root.path);
  const outside = writeFailure(400, `path escapes project_root ${resolved.root.project_root}`, "path_outside_project_root");
  let fileReal: string;
  let createdDir: string | undefined;
  try {
    fileReal = await realpath(resolved.absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (input.create !== true) return writeFailure(404, "Catalog file not found", "catalog_file_not_found");
    const existing = await nearestExistingDir(resolved.absolutePath);
    const existingReal = await realpath(existing);
    fileReal = path.join(existingReal, path.relative(existing, resolved.absolutePath));
    if (!isInsideProjectRoot(rootReal, existingReal) || !isInsideProjectRoot(rootReal, fileReal)) return outside;
    const firstNew = path.relative(existingReal, path.dirname(fileReal)).split(path.sep)[0];
    if (firstNew) {
      createdDir = path.join(existingReal, firstNew);
      await mkdir(path.dirname(fileReal), { recursive: true });
    }
    try {
      await writeFile(fileReal, input.content, { encoding: "utf8", flag: "wx" });
    } catch (writeErr) {
      if (createdDir !== undefined) await rm(createdDir, { recursive: true, force: true });
      if ((writeErr as NodeJS.ErrnoException).code === "EEXIST") {
        return writeFailure(409, "Catalog file already exists", "catalog_file_exists");
      }
      throw writeErr;
    }
    return validateWritten(input, resolved.relativePath, rootReal, fileReal, async () => {
      await rm(createdDir ?? fileReal, { recursive: true, force: true });
    });
  }

  if (!isInsideProjectRoot(rootReal, fileReal)) return outside;
  if (!isCatalogYamlExtension(fileReal)) {
    return writeFailure(400, "Only .yaml and .yml catalog files can be written", "unsupported_file_type");
  }
  if (!(await stat(fileReal)).isFile()) {
    return writeFailure(400, "Only .yaml and .yml catalog files can be written", "unsupported_file_type");
  }
  if (input.create === true) return writeFailure(409, "Catalog file already exists", "catalog_file_exists");
  const previous = await readFile(fileReal, "utf8");
  if (input.baseHash !== undefined && contentHash(previous) !== input.baseHash) {
    return writeFailure(409, CATALOG_FILE_CHANGED_MESSAGE, "FILE_CHANGED");
  }
  const content = input.preserveFormatting === true ? preserveOnto(previous, input.content) : input.content;
  await writeFileAtomic(fileReal, content);
  return validateWritten({ content }, resolved.relativePath, rootReal, fileReal, async () => {
    await writeFileAtomic(fileReal, previous);
  });
}

export const CATALOG_FILE_CHANGED_MESSAGE =
  "The file changed on disk since you opened it. Your edits were not saved.";

/** The editor's YAML applied onto the file as it is, keeping comments and untouched text. */
function preserveOnto(previous: string, content: string): string {
  let next: unknown;
  try {
    next = parseYaml(content);
  } catch {
    return content;
  }
  if (next === null || typeof next !== "object" || Array.isArray(next)) return content;
  return renderCatalogYaml(previous, next as Record<string, unknown>, { keepUnknownTopLevel: false });
}

/** Loads the written file as what it is; on failure undoes the write and answers with catalog-relative findings. */
async function validateWritten(
  input: { content: string },
  relativePath: string,
  rootReal: string,
  fileReal: string,
  undo: () => Promise<void>,
): Promise<WriteCatalogFileResult> {
  const kind = catalogFileKind(relativePath, input.content);
  const outcome = await loadCatalogFileOutcome(kind, fileReal, rootReal);
  if (outcome.ok) return { ok: true, path: relativePath, content: input.content, hash: contentHash(input.content) };
  await undo();
  const findings = findingsFromLoadIssues(rootReal, fileReal, outcome.issues).map((finding) => ({
    ...finding,
    message: withoutHostPaths(finding.message, [
      [fileReal, relativePath],
      [rootReal, "."],
    ]),
  }));
  return {
    ok: false,
    status: 400,
    error: findings[0]?.message ?? `Invalid ${kind} YAML`,
    code: INVALID_CODE[kind],
    findings,
  };
}

/** Load messages name the absolute file; the console and API answer with the catalog-relative path instead. */
function withoutHostPaths(message: string, replacements: Array<[string, string]>): string {
  let out = message;
  for (const [from, to] of [...replacements].sort((a, b) => b[0].length - a[0].length)) {
    if (from.length > 1) out = out.split(from).join(to);
  }
  return out;
}
