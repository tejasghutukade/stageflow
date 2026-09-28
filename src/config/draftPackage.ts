import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InlinePipelineDefinition } from "../types/pipeline.js";
import type { StageGateKind } from "../types/stage.js";
import { loadPipelineOutcome } from "./loadPipeline.js";
import type { PipelineListing } from "./listConfig.js";
import { parseTaskFile } from "./loadTask.js";
import { stringifyTargetYaml } from "./printTargetYaml.js";
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

async function writeDraftPackageFiles(
  projectRoot: string,
  target: ResolvedDraftWrite,
  allowInvalid: boolean | undefined,
): Promise<DraftPackageWriteResult> {
  const { packageDirectory, draft, pipelineAbsPath, pipelineRelPath } = target;
  const stagePaths: string[] = [];
  try {
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      pipelineAbsPath,
      stringifyTargetYaml(pipelineDocument(draft.pipeline)),
      "utf8",
    );

    for (const stage of draft.stages ?? []) {
      const rel = normalizeStageRelPath(stage.path);
      const stageAbs = path.join(packageDirectory, rel);
      await mkdir(path.dirname(stageAbs), { recursive: true });
      await writeFile(stageAbs, stringifyTargetYaml(stage.body), "utf8");
      stagePaths.push(path.relative(projectRoot, stageAbs).replace(/\\/g, "/"));
    }

    let taskPath: string | undefined;
    if (draft.task) {
      const taskAbs = path.join(packageDirectory, path.basename(draft.task.filename));
      await writeFile(taskAbs, stringifyTargetYaml(draft.task.body), "utf8");
      taskPath = path.relative(projectRoot, taskAbs).replace(/\\/g, "/");
    }

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
