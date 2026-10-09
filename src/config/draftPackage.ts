import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InlinePipelineDefinition } from "../types/pipeline.js";
import type { StageGateKind } from "../types/stage.js";
import { loadPipelineOutcome } from "./loadPipeline.js";
import type { PipelineListing } from "./listConfig.js";
import { parseTaskFile } from "./loadTask.js";
import { stringifyTargetYaml } from "./printTargetYaml.js";
import { readYamlObject } from "./readYamlObject.js";
import {
  buildValidationResult,
  findingsFromLoadIssues,
  loadPipelineValidated,
  validatePipeline,
  type ValidationFinding,
  type ValidationResult,
} from "./validateCatalog.js";

export type DraftStageArtifact = {
  path: string;
  body: Record<string, unknown>;
};

export type DraftPackage = {
  pipeline: {
    id: string;
    stages: Array<Record<string, unknown>>;
    agent?: unknown;
    model?: unknown;
    schemas?: unknown;
    requires?: unknown;
  };
  stages?: DraftStageArtifact[];
  task?: {
    filename: string;
    body: Record<string, unknown>;
  };
};

export type ValidateDraftPackageOptions = {
  cwd?: string;
  projectRoot?: string;
  strict?: boolean;
};

export type OverwriteDraftPackageInput = {
  directory: string;
  draft: DraftPackage;
  pipelineFilename?: string;
  /**
   * Escape hatch for Workshop “Save invalid anyway” (ticket 07).
   * When true, skips the validate gate and writes the package as-is.
   */
  allowInvalid?: boolean;
};

export type CreateDraftPackageInput = OverwriteDraftPackageInput;

export type DraftPackageWriteResult =
  | {
      ok: true;
      pipeline: PipelineListing;
      pipelinePath: string;
      stagePaths: string[];
      taskPath?: string;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 422 | 500;
      error: string;
      findings?: ValidationFinding[];
    };

export type OverwriteDraftPackageResult = DraftPackageWriteResult;
export type CreateDraftPackageResult = DraftPackageWriteResult;

export type DraftPackageDestination = {
  directory: string;
  pipelineFilename: string;
};

export type LoadDraftPackageOptions = {
  /** When set, attach this task file into the draft. Otherwise task stays absent. */
  taskPath?: string;
};

export type LoadDraftPackageResult =
  | {
      ok: true;
      draft: DraftPackage;
      destination: DraftPackageDestination;
      pipelinePath: string;
      taskPath?: string;
    }
  | {
      ok: false;
      status: 400 | 404;
      error: string;
    };

export type DraftTaskArtifact = {
  filename: string;
  body: Record<string, unknown>;
};

export type LoadTaskArtifactResult =
  | {
      ok: true;
      task: DraftTaskArtifact;
      taskPath: string;
    }
  | {
      ok: false;
      status: 400 | 404;
      error: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStageRelPath(stagePath: string): string {
  return stagePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function pipelineHasExternalUses(pipeline: DraftPackage["pipeline"]): boolean {
  return pipeline.stages.some(
    (stage) => typeof stage.uses === "string" && stage.uses.trim().length > 0,
  );
}

function pipelineDocument(pipeline: DraftPackage["pipeline"]): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: pipeline.id,
    stages: pipeline.stages,
  };
  if (pipeline.agent !== undefined) doc.agent = pipeline.agent;
  if (pipeline.model !== undefined) doc.model = pipeline.model;
  if (pipeline.schemas !== undefined) doc.schemas = pipeline.schemas;
  if (pipeline.requires !== undefined) doc.requires = pipeline.requires;
  return doc;
}

function resolveDirectory(projectRoot: string, directory: string): string | null {
  const absDirectory = path.resolve(projectRoot, directory);
  const rel = path.relative(projectRoot, absDirectory);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return absDirectory;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function materializeDraft(
  draft: DraftPackage,
  dir: string,
  pipelineFilename: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, pipelineFilename),
    stringifyTargetYaml(pipelineDocument(draft.pipeline)),
    "utf8",
  );

  for (const stage of draft.stages ?? []) {
    const rel = normalizeStageRelPath(stage.path);
    const stagePath = path.join(dir, rel);
    await mkdir(path.dirname(stagePath), { recursive: true });
    await writeFile(stagePath, stringifyTargetYaml(stage.body), "utf8");
  }

  if (draft.task) {
    await writeFile(
      path.join(dir, path.basename(draft.task.filename)),
      stringifyTargetYaml(draft.task.body),
      "utf8",
    );
  }
}

function collectTaskFindings(
  cwd: string,
  draft: DraftPackage,
): ValidationFinding[] {
  if (!draft.task) return [];
  const outcome = parseTaskFile(draft.task.body, `task ${draft.task.filename}`);
  if (outcome.ok) return [];
  const absPath = path.resolve(cwd, path.basename(draft.task.filename));
  return findingsFromLoadIssues(cwd, absPath, outcome.issues);
}

export async function validateDraftPackage(
  draft: DraftPackage,
  options: ValidateDraftPackageOptions = {},
): Promise<ValidationResult> {
  if (!isPlainObject(draft) || !isPlainObject(draft.pipeline)) {
    return buildValidationResult(
      "pipeline",
      [
        {
          severity: "error",
          code: "pipeline.invalid_shape",
          path: "<draft>",
          message: "draft package must include a pipeline object",
          category: "pipeline",
        },
      ],
      options.strict ?? false,
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const strict = options.strict ?? false;
  const findings: ValidationFinding[] = [];

  const needsMaterialize =
    pipelineHasExternalUses(draft.pipeline) ||
    (draft.stages !== undefined && draft.stages.length > 0);

  if (needsMaterialize) {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "sf-draft-"));
    try {
      const pipelineFilename = `${draft.pipeline.id}.pipeline.yaml`;
      await materializeDraft(draft, tempRoot, pipelineFilename);
      const pipelineResult = await validatePipeline(pipelineFilename, {
        cwd: tempRoot,
        projectRoot: tempRoot,
        validateStages: true,
        strict,
      });
      findings.push(...pipelineResult.findings);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  } else {
    const inline: InlinePipelineDefinition = {
      id: draft.pipeline.id,
      stages: draft.pipeline.stages,
      ...(draft.pipeline.agent !== undefined ? { agent: draft.pipeline.agent } : {}),
      ...(draft.pipeline.model !== undefined ? { model: draft.pipeline.model } : {}),
      ...(draft.pipeline.schemas !== undefined ? { schemas: draft.pipeline.schemas } : {}),
      ...(draft.pipeline.requires !== undefined
        ? { requires: draft.pipeline.requires }
        : {}),
    };
    const result = await loadPipelineValidated(inline, {
      cwd,
      projectRoot,
      validateStages: true,
    });
    findings.push(...result.findings);
  }

  findings.push(...collectTaskFindings(cwd, draft));
  return buildValidationResult("pipeline", findings, strict);
}

function buildPipelineListing(
  projectRoot: string,
  relPath: string,
  loaded: {
    pipeline: { id: string };
    stages: Array<{ id: string; gate_kinds?: StageGateKind[] }>;
    stageSources?: Record<
      string,
      { kind: "inline" } | { kind: "file"; path: string }
    >;
  },
): PipelineListing {
  return {
    path: relPath,
    id: loaded.pipeline.id,
    stages: loaded.stages.map((stage) => {
      const source = loaded.stageSources?.[stage.id];
      const listing = {
        id: stage.id,
        ...(stage.gate_kinds !== undefined ? { gate_kinds: stage.gate_kinds } : {}),
      };
      if (source?.kind === "inline") {
        return { ...listing, inline: true };
      }
      if (source?.kind === "file") {
        return {
          ...listing,
          uses_path: path.relative(projectRoot, source.path).replace(/\\/g, "/"),
        };
      }
      return listing;
    }),
  };
}

function listingFromDraft(
  pipelineRelPath: string,
  draft: DraftPackage,
  stagePaths: string[],
): PipelineListing {
  return {
    path: pipelineRelPath,
    id: draft.pipeline.id,
    stages: draft.pipeline.stages.map((stage, index) => {
      const id = typeof stage.id === "string" ? stage.id : `stage-${index}`;
      if (typeof stage.uses === "string" && stage.uses.trim()) {
        const match = stagePaths.find((p) => p.endsWith(normalizeStageRelPath(stage.uses as string)));
        return {
          id,
          ...(match !== undefined ? { uses_path: match } : {}),
        };
      }
      return { id, inline: true };
    }),
  };
}

type ResolvedDraftWrite = {
  packageDirectory: string;
  draft: DraftPackage;
  pipelineFilename: string;
  pipelineAbsPath: string;
  pipelineRelPath: string;
};

function resolveDraftWriteTarget(
  projectRoot: string,
  input: OverwriteDraftPackageInput,
): { ok: true; value: ResolvedDraftWrite } | { ok: false; status: 400; error: string } {
  if (typeof input.directory !== "string" || !input.directory.trim()) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  const directory = input.directory.trim().replace(/\\/g, "/");
  if (directory.endsWith(".yaml") || directory.endsWith(".yml")) {
    return {
      ok: false,
      status: 400,
      error: "directory must be a catalog folder, not a pipeline file path",
    };
  }

  const packageDirectory = resolveDirectory(projectRoot, directory);
  if (!packageDirectory) {
    return {
      ok: false,
      status: 400,
      error: "directory must be inside the project root",
    };
  }

  const draft = input.draft;
  if (!isPlainObject(draft?.pipeline) || typeof draft.pipeline.id !== "string") {
    return { ok: false, status: 400, error: "draft.pipeline.id is required" };
  }

  const pipelineFilename =
    input.pipelineFilename?.trim() || `${draft.pipeline.id}.pipeline.yaml`;
  const pipelineAbsPath = path.join(packageDirectory, path.basename(pipelineFilename));
  const pipelineRelPath = path
    .relative(projectRoot, pipelineAbsPath)
    .replace(/\\/g, "/");

  return {
    ok: true,
    value: {
      packageDirectory,
      draft,
      pipelineFilename,
      pipelineAbsPath,
      pipelineRelPath,
    },
  };
}

async function gateDraftWrite(
  projectRoot: string,
  draft: DraftPackage,
  allowInvalid: boolean | undefined,
): Promise<DraftPackageWriteResult | null> {
  if (allowInvalid) return null;
  const validation = await validateDraftPackage(draft, {
    cwd: projectRoot,
    projectRoot,
    strict: true,
  });
  if (validation.ok) return null;
  const errorFinding = validation.findings.find(
    (finding) => finding.severity === "error",
  );
  return {
    ok: false,
    status: 422,
    error: errorFinding?.message ?? "Package validation failed",
    findings: validation.findings,
  };
}

type DraftWriteFile = {
  kind: "pipeline" | "stage" | "task";
  absPath: string;
  relPath: string;
  content: string;
};

function resolveDraftWriteFiles(
  projectRoot: string,
  target: ResolvedDraftWrite,
): { ok: true; files: DraftWriteFile[] } | { ok: false; status: 400; error: string } {
  const { packageDirectory, draft, pipelineAbsPath, pipelineRelPath } = target;
  const toRel = (abs: string) => path.relative(projectRoot, abs).replace(/\\/g, "/");
  const files: DraftWriteFile[] = [
    {
      kind: "pipeline",
      absPath: pipelineAbsPath,
      relPath: pipelineRelPath,
      content: stringifyTargetYaml(pipelineDocument(draft.pipeline)),
    },
  ];

  for (const stage of draft.stages ?? []) {
    const rel = normalizeStageRelPath(stage.path);
    if (!rel || path.isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) {
      return {
        ok: false,
        status: 400,
        error: `Stage path escapes package directory (${stage.path})`,
      };
    }
    const stageAbs = path.resolve(packageDirectory, rel);
    const relToPackage = path.relative(packageDirectory, stageAbs);
    if (relToPackage.startsWith("..") || path.isAbsolute(relToPackage)) {
      return {
        ok: false,
        status: 400,
        error: `Stage path escapes package directory (${stage.path})`,
      };
    }
    files.push({
      kind: "stage",
      absPath: stageAbs,
      relPath: toRel(stageAbs),
      content: stringifyTargetYaml(stage.body),
    });
  }

  if (draft.task) {
    const taskAbs = path.join(packageDirectory, path.basename(draft.task.filename));
    files.push({
      kind: "task",
      absPath: taskAbs,
      relPath: toRel(taskAbs),
      content: stringifyTargetYaml(draft.task.body),
    });
  }

  return { ok: true, files };
}

async function writeDraftPackageFiles(
  projectRoot: string,
  target: ResolvedDraftWrite,
  allowInvalid: boolean | undefined,
): Promise<DraftPackageWriteResult> {
  const { packageDirectory, draft, pipelineRelPath } = target;
  const resolved = resolveDraftWriteFiles(projectRoot, target);
  if (!resolved.ok) return resolved;

  try {
    await mkdir(packageDirectory, { recursive: true });
    for (const file of resolved.files) {
      await mkdir(path.dirname(file.absPath), { recursive: true });
      await writeFile(file.absPath, file.content, "utf8");
    }
    const stagePaths = resolved.files
      .filter((file) => file.kind === "stage")
      .map((file) => file.relPath);
    const taskPath = resolved.files.find((file) => file.kind === "task")?.relPath;

    const loadOutcome = await loadPipelineOutcome(pipelineRelPath, {
      cwd: projectRoot,
    });
    const pipeline = loadOutcome.ok
      ? buildPipelineListing(projectRoot, pipelineRelPath, loadOutcome.value)
      : listingFromDraft(pipelineRelPath, draft, stagePaths);

    if (!loadOutcome.ok && !allowInvalid) {
      return {
        ok: false,
        status: 500,
        error: loadOutcome.issues[0]?.message ?? "Failed to load written pipeline",
      };
    }

    return {
      ok: true,
      pipeline,
      pipelinePath: pipelineRelPath,
      stagePaths,
      ...(taskPath !== undefined ? { taskPath } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }
}

export async function overwriteDraftPackage(
  projectRoot: string,
  input: OverwriteDraftPackageInput,
): Promise<OverwriteDraftPackageResult> {
  const resolved = resolveDraftWriteTarget(projectRoot, input);
  if (!resolved.ok) return resolved;

  if (!(await fileExists(resolved.value.pipelineAbsPath))) {
    return {
      ok: false,
      status: 404,
      error: `Pipeline does not exist (${resolved.value.pipelineRelPath})`,
    };
  }

  const blocked = await gateDraftWrite(
    projectRoot,
    resolved.value.draft,
    input.allowInvalid,
  );
  if (blocked) return blocked;

  return writeDraftPackageFiles(projectRoot, resolved.value, input.allowInvalid);
}

export async function createDraftPackage(
  projectRoot: string,
  input: CreateDraftPackageInput,
): Promise<CreateDraftPackageResult> {
  const resolved = resolveDraftWriteTarget(projectRoot, input);
  if (!resolved.ok) return resolved;

  if (await fileExists(resolved.value.pipelineAbsPath)) {
    return {
      ok: false,
      status: 409,
      error: `Pipeline already exists (${resolved.value.pipelineRelPath})`,
    };
  }

  const blocked = await gateDraftWrite(
    projectRoot,
    resolved.value.draft,
    input.allowInvalid,
  );
  if (blocked) return blocked;

  return writeDraftPackageFiles(projectRoot, resolved.value, input.allowInvalid);
}

export type DraftPlanMode = "create" | "overwrite";

export type DraftPlanFile = {
  path: string;
  kind: "pipeline" | "stage" | "task";
  action: "new" | "overwrite" | "unchanged";
  added: number;
  removed: number;
};

export type DraftPlanResult = {
  pipelinePath: string;
  directory: string;
  files: DraftPlanFile[];
  pipelineIdTaken: boolean;
};

export type PlanDraftPackageOptions = {
  mode?: DraftPlanMode;
  catalogPipelines?: ReadonlyArray<{ id: string; path: string }>;
};

function splitLines(text: string): string[] {
  if (!text) return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

export function countLineChanges(
  before: string,
  after: string,
): { added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let prev = new Uint32Array(midB.length + 1);
  let curr = new Uint32Array(midB.length + 1);
  for (const lineA of midA) {
    for (let j = 1; j <= midB.length; j += 1) {
      curr[j] =
        lineA === midB[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[midB.length]!;
  return { added: midB.length - common, removed: midA.length - common };
}

async function readExisting(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function planDraftPackage(
  projectRoot: string,
  input: CreateDraftPackageInput,
  options: PlanDraftPackageOptions = {},
): Promise<({ ok: true } & DraftPlanResult) | { ok: false; status: 400; error: string }> {
  const resolved = resolveDraftWriteTarget(projectRoot, input);
  if (!resolved.ok) return resolved;
  const writeFiles = resolveDraftWriteFiles(projectRoot, resolved.value);
  if (!writeFiles.ok) return writeFiles;

  const files: DraftPlanFile[] = [];
  for (const file of writeFiles.files) {
    const existing = await readExisting(file.absPath);
    if (existing === null) {
      files.push({
        path: file.relPath,
        kind: file.kind,
        action: "new",
        added: splitLines(file.content).length,
        removed: 0,
      });
    } else if (existing === file.content) {
      files.push({
        path: file.relPath,
        kind: file.kind,
        action: "unchanged",
        added: 0,
        removed: 0,
      });
    } else {
      files.push({
        path: file.relPath,
        kind: file.kind,
        action: "overwrite",
        ...countLineChanges(existing, file.content),
      });
    }
  }

  const { pipelineRelPath, packageDirectory, draft } = resolved.value;
  const pipelineIdTaken =
    (options.mode ?? "create") === "create" &&
    (options.catalogPipelines ?? []).some(
      (listing) =>
        listing.id === draft.pipeline.id &&
        listing.path.replace(/\\/g, "/") !== pipelineRelPath,
    );

  return {
    ok: true,
    pipelinePath: pipelineRelPath,
    directory:
      path.relative(projectRoot, packageDirectory).replace(/\\/g, "/") || ".",
    files,
    pipelineIdTaken,
  };
}

export function parsePlanDraftPackageBody(
  body: unknown,
):
  | (CreateDraftPackageInput & { mode: DraftPlanMode })
  | { ok: false; status: 400; error: string } {
  const parsed = parseCreateDraftPackageBody(body);
  if ("ok" in parsed) return parsed;
  const mode = isPlainObject(body) ? body.mode : undefined;
  if (mode !== undefined && mode !== "create" && mode !== "overwrite") {
    return { ok: false, status: 400, error: 'mode must be "create" or "overwrite"' };
  }
  return { ...parsed, mode: mode ?? "create" };
}

export function parseDraftPackageBody(
  body: unknown,
): DraftPackage | { ok: false; status: 400; error: string } {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "JSON object body required" };
  }
  const draftValue = isPlainObject(body.draft) ? body.draft : body;
  if (!isPlainObject(draftValue.pipeline)) {
    return { ok: false, status: 400, error: "draft.pipeline is required" };
  }
  if (typeof draftValue.pipeline.id !== "string" || !draftValue.pipeline.id.trim()) {
    return { ok: false, status: 400, error: "draft.pipeline.id is required" };
  }
  if (!Array.isArray(draftValue.pipeline.stages)) {
    return { ok: false, status: 400, error: "draft.pipeline.stages must be an array" };
  }
  return draftValue as DraftPackage;
}

export function parseCreateDraftPackageBody(
  body: unknown,
): CreateDraftPackageInput | { ok: false; status: 400; error: string } {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "JSON object body required" };
  }
  const draftParsed = parseDraftPackageBody(body);
  if ("ok" in draftParsed) return draftParsed;
  if (typeof body.directory !== "string" || !body.directory.trim()) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  return {
    directory: body.directory.trim(),
    draft: draftParsed,
    ...(typeof body.pipelineFilename === "string"
      ? { pipelineFilename: body.pipelineFilename }
      : {}),
    ...(body.allowInvalid === true ? { allowInvalid: true } : {}),
  };
}

export const parseOverwriteDraftPackageBody = parseCreateDraftPackageBody;

export type OpenDraftPackageInput = {
  path: string;
  taskPath?: string;
};

export function parseOpenDraftPackageBody(
  body: unknown,
): OpenDraftPackageInput | { ok: false; status: 400; error: string } {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "JSON object body required" };
  }
  if (typeof body.path !== "string" || !body.path.trim()) {
    return { ok: false, status: 400, error: "path is required" };
  }
  const pathValue = body.path.trim().replace(/\\/g, "/");
  const taskRaw =
    typeof body.task === "string"
      ? body.task
      : typeof body.taskPath === "string"
        ? body.taskPath
        : undefined;
  return {
    path: pathValue,
    ...(taskRaw?.trim() ? { taskPath: taskRaw.trim().replace(/\\/g, "/") } : {}),
  };
}

function resolveProjectRelativePath(
  projectRoot: string,
  relPath: string,
): string | null {
  const abs = path.resolve(projectRoot, relPath);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return abs;
}

/** Load a catalog task file into a draft task artifact (attach without reloading the pipeline). */
export async function loadTaskArtifact(
  projectRoot: string,
  taskRelPath: string,
): Promise<LoadTaskArtifactResult> {
  if (typeof taskRelPath !== "string" || !taskRelPath.trim()) {
    return { ok: false, status: 400, error: "task path is required" };
  }
  const taskRel = taskRelPath.trim().replace(/\\/g, "/");
  const taskAbs = resolveProjectRelativePath(projectRoot, taskRel);
  if (!taskAbs) {
    return {
      ok: false,
      status: 400,
      error: "task path must be inside the project root",
    };
  }
  if (!(await fileExists(taskAbs))) {
    return {
      ok: false,
      status: 404,
      error: `Task does not exist (${taskRel})`,
    };
  }
  try {
    const body = await readYamlObject(taskAbs);
    return {
      ok: true,
      task: {
        filename: path.basename(taskAbs),
        body,
      },
      taskPath: path.relative(projectRoot, taskAbs).replace(/\\/g, "/"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 400, error: `Failed to read task: ${message}` };
  }
}

export type AttachTaskBody = {
  taskPath: string;
};

export function parseAttachTaskBody(
  body: unknown,
): AttachTaskBody | { ok: false; status: 400; error: string } {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "JSON object body required" };
  }
  const taskRaw =
    typeof body.task === "string"
      ? body.task
      : typeof body.taskPath === "string"
        ? body.taskPath
        : undefined;
  if (!taskRaw?.trim()) {
    return { ok: false, status: 400, error: "task path is required" };
  }
  return { taskPath: taskRaw.trim().replace(/\\/g, "/") };
}

export async function loadDraftPackage(
  projectRoot: string,
  pipelineRelPath: string,
  options: LoadDraftPackageOptions = {},
): Promise<LoadDraftPackageResult> {
  if (typeof pipelineRelPath !== "string" || !pipelineRelPath.trim()) {
    return { ok: false, status: 400, error: "path is required" };
  }
  const normalizedRel = pipelineRelPath.trim().replace(/\\/g, "/");
  const pipelineAbs = resolveProjectRelativePath(projectRoot, normalizedRel);
  if (!pipelineAbs) {
    return {
      ok: false,
      status: 400,
      error: "path must be inside the project root",
    };
  }
  if (!(await fileExists(pipelineAbs))) {
    return {
      ok: false,
      status: 404,
      error: `Pipeline does not exist (${normalizedRel})`,
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = await readYamlObject(pipelineAbs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 400, error: `Failed to read pipeline: ${message}` };
  }

  if (typeof raw.id !== "string" || !raw.id.trim()) {
    return { ok: false, status: 400, error: "pipeline id is required" };
  }
  if (!Array.isArray(raw.stages)) {
    return { ok: false, status: 400, error: "pipeline stages must be an array" };
  }

  const packageDirectory = path.dirname(pipelineAbs);
  const pipelineFilename = path.basename(pipelineAbs);
  const directory = path
    .relative(projectRoot, packageDirectory)
    .replace(/\\/g, "/") || ".";
  const pipelinePath = path
    .relative(projectRoot, pipelineAbs)
    .replace(/\\/g, "/");

  const pipelineStages = raw.stages.filter(isPlainObject) as Array<
    Record<string, unknown>
  >;
  const stageArtifacts: DraftStageArtifact[] = [];
  const seenUses = new Set<string>();

  for (const stage of pipelineStages) {
    if (typeof stage.uses !== "string" || !stage.uses.trim()) continue;
    const uses = stage.uses.trim().replace(/\\/g, "/");
    const key = normalizeStageRelPath(uses);
    if (seenUses.has(key)) continue;
    seenUses.add(key);

    const stageAbs = path.resolve(packageDirectory, uses);
    const stageRelToRoot = path.relative(projectRoot, stageAbs);
    if (stageRelToRoot.startsWith("..") || path.isAbsolute(stageRelToRoot)) {
      return {
        ok: false,
        status: 400,
        error: `Stage path escapes project root (${uses})`,
      };
    }
    if (!(await fileExists(stageAbs))) {
      return {
        ok: false,
        status: 404,
        error: `Stage file does not exist (${path
          .relative(projectRoot, stageAbs)
          .replace(/\\/g, "/")})`,
      };
    }
    try {
      const body = await readYamlObject(stageAbs);
      stageArtifacts.push({ path: uses, body });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 400,
        error: `Failed to read stage ${uses}: ${message}`,
      };
    }
  }

  const draft: DraftPackage = {
    pipeline: {
      id: raw.id,
      stages: pipelineStages,
      ...(raw.agent !== undefined ? { agent: raw.agent } : {}),
      ...(raw.model !== undefined ? { model: raw.model } : {}),
      ...(raw.schemas !== undefined ? { schemas: raw.schemas } : {}),
      ...(raw.requires !== undefined ? { requires: raw.requires } : {}),
    },
    ...(stageArtifacts.length > 0 ? { stages: stageArtifacts } : {}),
  };

  let attachedTaskPath: string | undefined;
  if (options.taskPath?.trim()) {
    const loaded = await loadTaskArtifact(projectRoot, options.taskPath);
    if (!loaded.ok) {
      return {
        ok: false,
        status: loaded.status,
        error: loaded.error,
      };
    }
    draft.task = loaded.task;
    attachedTaskPath = loaded.taskPath;
  }

  return {
    ok: true,
    draft,
    destination: { directory, pipelineFilename },
    pipelinePath,
    ...(attachedTaskPath !== undefined ? { taskPath: attachedTaskPath } : {}),
  };
}
