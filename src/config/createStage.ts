import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STAGE_GATE_KINDS,
  type StageGateKind,
} from "../types/stage.js";
import { loadStage } from "./loadStage.js";
import { readYamlObject } from "./readYamlObject.js";

export const STAGE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type CreateStageInput = {
  pipeline_directory: string;
  filename: string;
  id: string;
  system_prompt: string;
  model: string;
  gate_kinds?: StageGateKind[];
};

export type CreatedStageListing = {
  path: string;
  id: string;
  gate_kinds?: StageGateKind[];
};

export type CreateStageParseError = {
  ok: false;
  status: 400;
  error: string;
};

export type CreateStageResult =
  | { ok: true; stage: CreatedStageListing }
  | { ok: false; status: 400 | 409 | 500; error: string };

function isGateKind(value: string): value is StageGateKind {
  return (STAGE_GATE_KINDS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStageId(id: string): string | null {
  if (id.length === 0 || id.length > 64) {
    return "id must be 1-64 characters";
  }
  if (!STAGE_ID_PATTERN.test(id)) {
    return "id must be lowercase kebab-case";
  }
  return null;
}

function parseGateKinds(raw: unknown): StageGateKind[] | "invalid" | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return "invalid";
  const kinds: StageGateKind[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isGateKind(item)) {
      return "invalid";
    }
    kinds.push(item);
  }
  return kinds;
}

export function parseCreateStageBody(
  body: unknown,
): CreateStageInput | CreateStageParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  if ("payload_schema" in body) {
    return { ok: false, status: 400, error: "payload_schema is not supported" };
  }
  if ("skill" in body) {
    return { ok: false, status: 400, error: "skill is not supported" };
  }

  if (typeof body.pipeline_directory !== "string" || !body.pipeline_directory.trim()) {
    return { ok: false, status: 400, error: "pipeline_directory is required" };
  }
  if (typeof body.filename !== "string" || !body.filename.trim()) {
    return { ok: false, status: 400, error: "filename is required" };
  }
  const filename = body.filename.trim().replace(/\\/g, "/");
  if (!filename.endsWith(".yaml") && !filename.endsWith(".yml")) {
    return { ok: false, status: 400, error: "filename must end with .yaml" };
  }

  if (typeof body.id !== "string") {
    return { ok: false, status: 400, error: "id is required" };
  }
  const idError = validateStageId(body.id);
  if (idError) {
    return { ok: false, status: 400, error: idError };
  }

  if (typeof body.system_prompt !== "string" || body.system_prompt.length === 0) {
    return { ok: false, status: 400, error: "system_prompt is required" };
  }

  if (typeof body.model !== "string" || body.model.length === 0) {
    return { ok: false, status: 400, error: "model is required" };
  }

  const gateKinds = parseGateKinds(body.gate_kinds);
  if (gateKinds === "invalid") {
    return {
      ok: false,
      status: 400,
      error: `gate_kinds must be a non-empty array of: ${STAGE_GATE_KINDS.join(", ")}`,
    };
  }

  return {
    pipeline_directory: body.pipeline_directory.trim().replace(/\\/g, "/"),
    filename,
    id: body.id,
    system_prompt: body.system_prompt,
    model: body.model,
    ...(gateKinds ? { gate_kinds: gateKinds } : {}),
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

export function stageConfigToYaml(stage: Omit<CreateStageInput, "pipeline_directory" | "filename">): string {
  const lines: string[] = [`id: ${stage.id}`];
  if (stage.gate_kinds && stage.gate_kinds.length > 0) {
    lines.push("gate_kinds:");
    for (const kind of stage.gate_kinds) {
      lines.push(`  - ${kind}`);
    }
  }
  if (stage.system_prompt.includes("\n")) {
    lines.push("system_prompt: |");
    for (const line of stage.system_prompt.split("\n")) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push(`system_prompt: ${formatInlineYamlScalar(stage.system_prompt)}`);
  }
  lines.push(`model: ${formatInlineYamlScalar(stage.model)}`);
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

function resolvePipelineDirectory(
  projectRoot: string,
  pipelineDirectory: string,
): string | null {
  const absDirectory = path.resolve(projectRoot, pipelineDirectory);
  const rel = path.relative(projectRoot, absDirectory);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return absDirectory;
}

async function findStageIdCollision(
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

export async function createStage(
  projectRoot: string,
  input: CreateStageInput,
): Promise<CreateStageResult> {
  const pipelineDirectory = resolvePipelineDirectory(projectRoot, input.pipeline_directory);
  if (!pipelineDirectory) {
    return {
      ok: false,
      status: 400,
      error: "pipeline_directory must be inside the project root",
    };
  }

  const filePath = path.join(pipelineDirectory, path.basename(input.filename));
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");

  const collision = await findStageIdCollision(
    pipelineDirectory,
    projectRoot,
    input.id,
    filePath,
  );
  if (collision) {
    return {
      ok: false,
      status: 409,
      error: `Stage id already exists (${collision})`,
    };
  }

  try {
    await mkdir(pipelineDirectory, { recursive: true });
    await writeFile(
      filePath,
      stageConfigToYaml({
        id: input.id,
        system_prompt: input.system_prompt,
        model: input.model,
        ...(input.gate_kinds ? { gate_kinds: input.gate_kinds } : {}),
      }),
      "utf8",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }

  try {
    const stage = await loadStage(filePath);
    return {
      ok: true,
      stage: {
        path: relPath,
        id: stage.id,
        ...(stage.gate_kinds ? { gate_kinds: stage.gate_kinds } : {}),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }
}
