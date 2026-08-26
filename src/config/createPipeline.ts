import { access, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedPipelineStageEntry } from "../types/pipeline.js";
import type { StageGateKind } from "../types/stage.js";
import { STAGE_ID_PATTERN } from "./createStage.js";
import type { RawMergedEntry } from "./mergePipelineIncludes.js";
import type { PipelineListing } from "./listConfig.js";
import {
  inferIdFromUsesPath,
  normalizePipelineStageEntries,
  toWiringRefs,
} from "./normalizePipelineStageEntry.js";
import { readYamlObject } from "./readYamlObject.js";
import { resolvePipelineDagFromRefs } from "./resolvePipelineDag.js";
import { validatePipeline } from "./validateCatalog.js";
import { loadPipelineOutcome } from "./loadPipeline.js";

export type CreatePipelineStageInline = {
  system_prompt: string;
  model: string;
  gate_kinds?: StageGateKind[];
};

export type CreatePipelineStageRef = {
  id: string;
  needs?: string;
  uses?: string;
  inline?: CreatePipelineStageInline;
};

export type CreatePipelineInput = {
  directory: string;
  id: string;
  stages: CreatePipelineStageRef[];
};

export type CreatePipelineParseError = {
  ok: false;
  status: 400;
  error: string;
};

export type CreatePipelineResult =
  | { ok: true; pipeline: PipelineListing }
  | { ok: false; status: 400 | 409 | 422 | 500; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePipelineId(id: string): string | null {
  if (id.length === 0 || id.length > 64) {
    return "id must be 1-64 characters";
  }
  if (!STAGE_ID_PATTERN.test(id)) {
    return "id must be lowercase kebab-case";
  }
  return null;
}

function defaultUsesPath(stageId: string): string {
  return `./${stageId}.yaml`;
}

export function normalizeCreatePipelineStages(
  stages: CreatePipelineStageRef[],
): CreatePipelineStageRef[] {
  return stages.map((stage) => ({
    ...stage,
    uses: stage.uses ?? (stage.inline ? undefined : defaultUsesPath(stage.id)),
  }));
}

function stageRefToRaw(ref: CreatePipelineStageRef): Record<string, unknown> {
  const raw: Record<string, unknown> = { id: ref.id };
  if (ref.needs !== undefined) raw.needs = ref.needs;
  if (ref.uses !== undefined) raw.uses = ref.uses;
  if (ref.inline) {
    raw.system_prompt = ref.inline.system_prompt;
    raw.model = ref.inline.model;
    if (ref.inline.gate_kinds !== undefined) {
      raw.gate_kinds = ref.inline.gate_kinds;
    }
  }
  return raw;
}

function toAuthoringRawEntries(
  stages: CreatePipelineStageRef[],
  declaringPath: string,
): RawMergedEntry[] {
  return stages.map((stage) => ({
    raw: stageRefToRaw(stage),
    declaringPath,
  }));
}

function normalizedToCreateRefs(
  entries: NormalizedPipelineStageEntry[],
): CreatePipelineStageRef[] {
  return entries.map((entry) => {
    const ref: CreatePipelineStageRef = { id: entry.id };
    if (entry.needs !== undefined) ref.needs = entry.needs;
    if (entry.body.kind === "uses") {
      ref.uses = entry.body.path;
    } else {
      const raw = entry.body.raw;
      ref.inline = {
        system_prompt: String(raw.system_prompt ?? ""),
        model: String(raw.model ?? ""),
        ...(Array.isArray(raw.gate_kinds)
          ? { gate_kinds: raw.gate_kinds as StageGateKind[] }
          : {}),
      };
    }
    return ref;
  });
}

function normalizeAuthoringStages(
  stages: CreatePipelineStageRef[],
  ctx: { pipelineId: string; path: string },
):
  | { ok: true; stages: CreatePipelineStageRef[] }
  | { ok: false; status: 422; error: string } {
  const prepared = normalizeCreatePipelineStages(stages);
  const normalizeOutcome = normalizePipelineStageEntries(
    toAuthoringRawEntries(prepared, ctx.path),
    ctx,
  );
  if (!normalizeOutcome.ok) {
    return {
      ok: false,
      status: 422,
      error: normalizeOutcome.issues[0]?.message ?? "Invalid pipeline stages",
    };
  }

  try {
    resolvePipelineDagFromRefs(toWiringRefs(normalizeOutcome.value), ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 422, error: message };
  }

  return { ok: true, stages: normalizedToCreateRefs(normalizeOutcome.value) };
}

function parseInlineBody(
  entry: Record<string, unknown>,
  index: number,
): CreatePipelineStageInline | CreatePipelineParseError {
  if (typeof entry.system_prompt !== "string" || entry.system_prompt.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `stages[${index}].system_prompt is required for inline stage`,
    };
  }
  if (typeof entry.model !== "string" || entry.model.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `stages[${index}].model is required for inline stage`,
    };
  }
  const inline: CreatePipelineStageInline = {
    system_prompt: entry.system_prompt,
    model: entry.model,
  };
  if (entry.gate_kinds !== undefined) {
    if (!Array.isArray(entry.gate_kinds)) {
      return {
        ok: false,
        status: 400,
        error: `stages[${index}].gate_kinds must be an array`,
      };
    }
    inline.gate_kinds = entry.gate_kinds as StageGateKind[];
  }
  return inline;
}

function parseStageEntry(
  entry: unknown,
  index: number,
): CreatePipelineStageRef | CreatePipelineParseError {
  if (typeof entry === "string") {
    const hint = entry
      ? `bare string stage refs are not supported; use { id: "${entry}", uses: "./${entry}.yaml" } or inline body`
      : `bare string stage refs are not supported; use { id: "…", uses: "./….yaml" } or inline body`;
    return {
      ok: false,
      status: 400,
      error: `stages[${index}]: ${hint}`,
    };
  }

  if (!isPlainObject(entry)) {
    return {
      ok: false,
      status: 400,
      error: `stages[${index}] must be an object with id`,
    };
  }

  let id = typeof entry.id === "string" ? entry.id : undefined;
  const uses =
    typeof entry.uses === "string" && entry.uses.trim() ? entry.uses : undefined;

  if (!id && uses) {
    const inferred = inferIdFromUsesPath(uses);
    if (inferred) id = inferred;
  }

  if (!id) {
    return { ok: false, status: 400, error: `stages[${index}].id is required` };
  }

  const ref: CreatePipelineStageRef = { id };

  if (entry.needs !== undefined) {
    if (typeof entry.needs !== "string") {
      return {
        ok: false,
        status: 400,
        error: `stages[${index}].needs must be a string`,
      };
    }
    ref.needs = entry.needs;
  }

  if (entry.uses !== undefined) {
    if (typeof entry.uses !== "string" || !entry.uses.trim()) {
      return {
        ok: false,
        status: 400,
        error: `stages[${index}].uses must be a non-empty string`,
      };
    }
    ref.uses = entry.uses;
  } else if (uses) {
    ref.uses = uses;
  }

  const hasInlineFields =
    entry.system_prompt !== undefined ||
    entry.model !== undefined ||
    entry.gate_kinds !== undefined;
  if (hasInlineFields) {
    const inline = parseInlineBody(entry, index);
    if ("ok" in inline) return inline;
    ref.inline = inline;
  }

  return ref;
}

export function parseCreatePipelineBody(
  body: unknown,
): CreatePipelineInput | CreatePipelineParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }

  if (typeof body.directory !== "string" || !body.directory.trim()) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  const directory = body.directory.trim().replace(/\\/g, "/");
  if (directory.endsWith(".yaml") || directory.endsWith(".yml")) {
    return {
      ok: false,
      status: 400,
      error: "directory must be a catalog folder, not a pipeline file path",
    };
  }

  if (typeof body.id !== "string") {
    return { ok: false, status: 400, error: "id is required" };
  }
  const idError = validatePipelineId(body.id);
  if (idError) {
    return { ok: false, status: 400, error: idError };
  }

  if (!Array.isArray(body.stages)) {
    return { ok: false, status: 400, error: "stages must be an array" };
  }
  if (body.stages.length === 0) {
    return { ok: false, status: 400, error: "stages must be a non-empty array" };
  }

  const refs: CreatePipelineStageRef[] = [];
  for (let index = 0; index < body.stages.length; index++) {
    const parsed = parseStageEntry(body.stages[index], index);
    if ("ok" in parsed) {
      return parsed;
    }
    refs.push(parsed);
  }

  return {
    directory,
    id: body.id,
    stages: refs,
  };
}

function formatInlineYamlScalar(value: string): string {
  if (
    value.includes("\n") ||
    /[:#"'&*!|>@`[\]{}]/.test(value) ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.startsWith("-") ||
    value.startsWith("?")
  ) {
    return JSON.stringify(value);
  }
  return value;
}

export function pipelineConfigToYaml(
  pipeline: { id: string; stages: CreatePipelineStageRef[] },
  options: { format: "linear" | "dag" },
): string {
  const lines: string[] = [`id: ${pipeline.id}`, "stages:"];
  for (const stage of pipeline.stages) {
    if (options.format === "linear" && !stage.needs && !stage.inline && stage.uses) {
      lines.push(`  - id: ${stage.id}`);
      lines.push(`    uses: ${stage.uses}`);
      continue;
    }
    lines.push(`  - id: ${stage.id}`);
    if (stage.needs) {
      lines.push(`    needs: ${stage.needs}`);
    }
    if (stage.inline) {
      if (stage.inline.gate_kinds && stage.inline.gate_kinds.length > 0) {
        lines.push("    gate_kinds:");
        for (const kind of stage.inline.gate_kinds) {
          lines.push(`      - ${kind}`);
        }
      }
      if (stage.inline.system_prompt.includes("\n")) {
        lines.push("    system_prompt: |");
        for (const line of stage.inline.system_prompt.split("\n")) {
          lines.push(`      ${line}`);
        }
      } else {
        lines.push(
          `    system_prompt: ${formatInlineYamlScalar(stage.inline.system_prompt)}`,
        );
      }
      lines.push(`    model: ${formatInlineYamlScalar(stage.inline.model)}`);
    } else if (stage.uses) {
      lines.push(`    uses: ${stage.uses}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveDirectory(projectRoot: string, directory: string): string | null {
  const absDirectory = path.resolve(projectRoot, directory);
  const rel = path.relative(projectRoot, absDirectory);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return absDirectory;
}

async function findPipelineIdCollision(
  pipelineDirectory: string,
  projectRoot: string,
  id: string,
  targetPath: string,
): Promise<string | null> {
  if (await fileExists(targetPath)) {
    return path.relative(projectRoot, targetPath);
  }

  let entries;
  try {
    entries = await readdir(pipelineDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const filePath = path.join(pipelineDirectory, entry.name);
    if (filePath === targetPath) continue;
    try {
      const raw = await readYamlObject(filePath);
      if (raw?.id === id) {
        return path.relative(projectRoot, filePath);
      }
    } catch {
      // ignore unreadable files for collision scan
    }
  }
  return null;
}

async function validateStageReferences(
  pipelineDirectory: string,
  stages: CreatePipelineStageRef[],
): Promise<{ ok: true } | { ok: false; status: 422; error: string }> {
  const seen = new Set<string>();
  for (const stage of stages) {
    if (seen.has(stage.id)) {
      return {
        ok: false,
        status: 422,
        error: "Pipeline stages must not contain duplicates",
      };
    }
    seen.add(stage.id);
  }

  const inlineCount = stages.filter((stage) => stage.inline).length;
  if (inlineCount > 0 && stages.length > 1) {
    return {
      ok: false,
      status: 422,
      error: "Inline stage bodies are supported for single-stage pipelines only",
    };
  }

  for (const stage of stages) {
    if (stage.inline) continue;
    const uses = stage.uses ?? defaultUsesPath(stage.id);
    const stagePath = path.resolve(pipelineDirectory, uses);
    if (!(await fileExists(stagePath))) {
      return {
        ok: false,
        status: 422,
        error: `missing stage file for "${stage.id}" at ${uses}`,
      };
    }
  }

  return { ok: true };
}

function usesDagYaml(normalized: CreatePipelineStageRef[]): boolean {
  return normalized.some((ref) => ref.needs !== undefined);
}

function buildPipelineListing(
  projectRoot: string,
  relPath: string,
  loaded: {
    pipeline: { id: string };
    stages: Array<{ id: string; gate_kinds?: StageGateKind[] }>;
    stageSources?: Record<string, { kind: "inline" } | { kind: "file"; path: string }>;
  },
): PipelineListing {
  return {
    path: relPath,
    id: loaded.pipeline.id,
    stages: loaded.stages.map((stage) => {
      const source = loaded.stageSources?.[stage.id];
      const listing = {
        id: stage.id,
        ...(stage.gate_kinds ? { gate_kinds: stage.gate_kinds } : {}),
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

export async function createPipeline(
  projectRoot: string,
  input: CreatePipelineInput,
): Promise<CreatePipelineResult> {
  const pipelineDirectory = resolveDirectory(projectRoot, input.directory);
  if (!pipelineDirectory) {
    return {
      ok: false,
      status: 400,
      error: "directory must be inside the project root",
    };
  }

  const filePath = path.join(pipelineDirectory, `${input.id}.pipeline.yaml`);
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
  const validationCtx = { pipelineId: input.id, path: relPath };

  const normalizedOutcome = normalizeAuthoringStages(input.stages, validationCtx);
  if (!normalizedOutcome.ok) {
    return normalizedOutcome;
  }
  const normalized = normalizedOutcome.stages;

  const stageValidation = await validateStageReferences(pipelineDirectory, normalized);
  if (!stageValidation.ok) {
    return stageValidation;
  }

  const collision = await findPipelineIdCollision(
    pipelineDirectory,
    projectRoot,
    input.id,
    filePath,
  );
  if (collision) {
    return {
      ok: false,
      status: 409,
      error: `Pipeline id already exists (${collision})`,
    };
  }

  const yamlFormat = usesDagYaml(normalized) ? "dag" : "linear";

  try {
    await mkdir(pipelineDirectory, { recursive: true });
    await writeFile(
      filePath,
      pipelineConfigToYaml({ id: input.id, stages: normalized }, { format: yamlFormat }),
      "utf8",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }

  const validation = await validatePipeline(relPath, {
    cwd: projectRoot,
    validateStages: true,
    strict: true,
  });
  if (!validation.ok) {
    await unlink(filePath).catch(() => {});
    const errorFinding = validation.findings.find((finding) => finding.severity === "error");
    return {
      ok: false,
      status: 422,
      error: errorFinding?.message ?? "Pipeline validation failed",
    };
  }

  const loadOutcome = await loadPipelineOutcome(relPath, { cwd: projectRoot });
  if (!loadOutcome.ok) {
    await unlink(filePath).catch(() => {});
    return {
      ok: false,
      status: 500,
      error: loadOutcome.issues[0]?.message ?? "Failed to load created pipeline",
    };
  }

  return {
    ok: true,
    pipeline: buildPipelineListing(projectRoot, relPath, loadOutcome.value),
  };
}
