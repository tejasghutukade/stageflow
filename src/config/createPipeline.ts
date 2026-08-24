import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { STAGE_ID_PATTERN } from "./createStage.js";
import { loadPipeline } from "./loadPipeline.js";
import { loadStage } from "./loadStage.js";
import type { PipelineListing } from "./listConfig.js";
import { readYamlObject } from "./readYamlObject.js";
import { resolvePipelineDag } from "./resolvePipelineDag.js";

export type CreatePipelineStageRef = {
  id: string;
  needs?: string;
};

export type CreatePipelineInput = {
  id: string;
  stages: CreatePipelineStageRef[] | string[];
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

export function normalizeCreatePipelineStages(
  stages: CreatePipelineStageRef[] | string[],
): CreatePipelineStageRef[] {
  if (stages.length > 0 && typeof stages[0] === "string") {
    return (stages as string[]).map((id) => ({ id }));
  }
  return stages as CreatePipelineStageRef[];
}

function parseStageEntry(
  entry: unknown,
  index: number,
): CreatePipelineStageRef | CreatePipelineParseError {
  if (!isPlainObject(entry)) {
    return {
      ok: false,
      status: 400,
      error: `stages[${index}] must be a string or object with id`,
    };
  }

  if (typeof entry.id !== "string") {
    return { ok: false, status: 400, error: `stages[${index}].id is required` };
  }

  const ref: CreatePipelineStageRef = { id: entry.id };

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

  return ref;
}

export function parseCreatePipelineBody(
  body: unknown,
): CreatePipelineInput | CreatePipelineParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
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

  let hasString = false;
  let hasObject = false;
  for (const entry of body.stages) {
    if (typeof entry === "string") {
      hasString = true;
    } else if (isPlainObject(entry)) {
      hasObject = true;
    } else {
      return { ok: false, status: 400, error: "stages must be an array of strings" };
    }
  }

  if (hasString && hasObject) {
    return {
      ok: false,
      status: 400,
      error: "stages must be either all strings or all objects",
    };
  }

  if (hasString) {
    return {
      id: body.id,
      stages: body.stages as string[],
    };
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
    id: body.id,
    stages: refs,
  };
}

export function pipelineConfigToYaml(
  pipeline: { id: string; stages: CreatePipelineStageRef[] },
  options: { format: "linear" | "dag" },
): string {
  const lines: string[] = [`id: ${pipeline.id}`, "stages:"];
  if (options.format === "linear") {
    for (const stage of pipeline.stages) {
      lines.push(`  - ${stage.id}`);
    }
  } else {
    for (const stage of pipeline.stages) {
      lines.push(`  - id: ${stage.id}`);
      if (stage.needs) {
        lines.push(`    needs: ${stage.needs}`);
      }
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

async function findPipelineIdCollision(
  cwd: string,
  id: string,
  targetPath: string,
): Promise<string | null> {
  if (await fileExists(targetPath)) {
    return path.relative(cwd, targetPath);
  }

  const dir = path.join(cwd, "pipelines");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const filePath = path.join(dir, entry.name);
    if (filePath === targetPath) continue;
    try {
      const raw = await readYamlObject(filePath);
      if (raw?.id === id) {
        return path.relative(cwd, filePath);
      }
    } catch {
      // ignore unreadable files for collision scan
    }
  }
  return null;
}

async function validateStageReferences(
  cwd: string,
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

  const stagesDir = path.join(cwd, "stages");
  for (const stage of stages) {
    const stagePath = path.join(stagesDir, `${stage.id}.yaml`);
    try {
      await loadStage(stagePath);
    } catch {
      return {
        ok: false,
        status: 422,
        error: "one or more selected Stages no longer exist",
      };
    }
  }

  return { ok: true };
}

function buildResolverInput(
  input: CreatePipelineInput,
  normalized: CreatePipelineStageRef[],
): unknown[] {
  if (input.stages.length > 0 && typeof input.stages[0] === "string") {
    return input.stages as string[];
  }
  return normalized.map((ref) =>
    ref.needs ? { id: ref.id, needs: ref.needs } : { id: ref.id },
  );
}

function usesDagYaml(input: CreatePipelineInput, normalized: CreatePipelineStageRef[]): boolean {
  if (input.stages.length > 0 && typeof input.stages[0] !== "string") {
    return true;
  }
  return normalized.some((ref) => ref.needs !== undefined);
}

export async function createPipeline(
  cwd: string,
  input: CreatePipelineInput,
): Promise<CreatePipelineResult> {
  const normalized = normalizeCreatePipelineStages(input.stages);

  const stageValidation = await validateStageReferences(cwd, normalized);
  if (!stageValidation.ok) {
    return stageValidation;
  }

  const pipelinesDir = path.join(cwd, "pipelines");
  const filePath = path.join(pipelinesDir, `${input.id}.yaml`);
  const relPath = path.relative(cwd, filePath);

  const collision = await findPipelineIdCollision(cwd, input.id, filePath);
  if (collision) {
    return {
      ok: false,
      status: 409,
      error: `Pipeline id already exists (${collision})`,
    };
  }

  const resolverInput = buildResolverInput(input, normalized);
  try {
    resolvePipelineDag(resolverInput, { pipelineId: input.id, path: relPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 422, error: message };
  }

  const yamlFormat = usesDagYaml(input, normalized) ? "dag" : "linear";

  try {
    await mkdir(pipelinesDir, { recursive: true });
    await writeFile(
      filePath,
      pipelineConfigToYaml({ id: input.id, stages: normalized }, { format: yamlFormat }),
      "utf8",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }

  try {
    const loaded = await loadPipeline(filePath, { cwd });
    return {
      ok: true,
      pipeline: {
        path: relPath,
        id: loaded.pipeline.id,
        stages: loaded.stages.map((stage) => ({
          id: stage.id,
          ...(stage.gate_kinds ? { gate_kinds: stage.gate_kinds } : {}),
        })),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }
}
