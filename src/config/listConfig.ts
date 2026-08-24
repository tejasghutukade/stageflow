import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  STAGE_GATE_KINDS,
  type StageGateKind,
} from "../types/stage.js";
import { loadPipeline } from "./loadPipeline.js";
import { loadStage } from "./loadStage.js";
import { loadTask } from "./loadTask.js";
import { readYamlObject } from "./readYamlObject.js";
import { extractPipelineStageIds } from "./resolvePipelineDag.js";

export type TaskListing = {
  path: string;
  id: string;
  goal: string;
};

export type PipelineStageListing = {
  id: string;
  gate_kinds?: StageGateKind[];
};

export type PipelineListing = {
  path: string;
  id: string;
  stages: PipelineStageListing[];
};

export type ValidStageListing = {
  path: string;
  id: string;
  used_by_pipeline_ids: string[];
  gate_kinds?: StageGateKind[];
};

export type BrokenStageListing = {
  path: string;
  error: string;
  id?: string;
  model?: string;
  gate_kinds?: StageGateKind[];
};

export type StageListing = ValidStageListing | BrokenStageListing;

const BAKED_MODEL_IDS = [
  "anthropic/claude-sonnet-4-5",
  "cursor/auto",
  "cursor/composer-2-5",
] as const;

function parseSafeGateKinds(raw: unknown): StageGateKind[] | undefined {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    return undefined;
  }
  const allowed = new Set<string>(STAGE_GATE_KINDS);
  const gateKinds = raw.filter((item): item is StageGateKind => allowed.has(item));
  return gateKinds.length > 0 ? gateKinds : undefined;
}

async function listPipelineUsageByStage(cwd: string): Promise<Map<string, Set<string>>> {
  const dir = path.join(cwd, "pipelines");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const usage = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const raw = await readYamlObject(filePath);
      if (typeof raw?.id !== "string" || !Array.isArray(raw.stages)) continue;
      const stageIds = extractPipelineStageIds(raw.stages);
      if (!stageIds) continue;
      for (const stageId of stageIds) {
        let pipelineIds = usage.get(stageId);
        if (!pipelineIds) {
          pipelineIds = new Set<string>();
          usage.set(stageId, pipelineIds);
        }
        pipelineIds.add(raw.id);
      }
    } catch {
      // skip invalid pipeline files
    }
  }
  return usage;
}

export async function listTasks(cwd: string): Promise<TaskListing[]> {
  const dir = path.join(cwd, "tasks");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const listings: TaskListing[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const task = await loadTask(filePath);
      listings.push({
        path: path.relative(cwd, filePath),
        id: task.id,
        goal: task.goal,
      });
    } catch {
      // skip invalid
    }
  }
  listings.sort((a, b) => a.id.localeCompare(b.id));
  return listings;
}

export async function listPipelines(cwd: string): Promise<PipelineListing[]> {
  const dir = path.join(cwd, "pipelines");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const listings: PipelineListing[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const loaded = await loadPipeline(filePath, { cwd });
      listings.push({
        path: path.relative(cwd, filePath),
        id: loaded.pipeline.id,
        stages: loaded.stages.map((stage) => ({
          id: stage.id,
          ...(stage.gate_kinds ? { gate_kinds: stage.gate_kinds } : {}),
        })),
      });
    } catch {
      // skip invalid
    }
  }
  listings.sort((a, b) => a.id.localeCompare(b.id));
  return listings;
}

export async function listStages(cwd: string): Promise<StageListing[]> {
  const dir = path.join(cwd, "stages");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const usageByStage = await listPipelineUsageByStage(cwd);
  const valid: ValidStageListing[] = [];
  const broken: BrokenStageListing[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const filePath = path.join(dir, entry.name);
    const relPath = path.relative(cwd, filePath);
    try {
      const stage = await loadStage(filePath);
      valid.push({
        path: relPath,
        id: stage.id,
        used_by_pipeline_ids: [...(usageByStage.get(stage.id) ?? new Set<string>())].sort(),
        ...(stage.gate_kinds ? { gate_kinds: stage.gate_kinds } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const brokenRow: BrokenStageListing = {
        path: relPath,
        error: message,
      };
      try {
        const raw = await readYamlObject(filePath);
        if (typeof raw?.id === "string") brokenRow.id = raw.id;
        if (typeof raw?.model === "string") brokenRow.model = raw.model;
        const gateKinds = parseSafeGateKinds(raw?.gate_kinds);
        if (gateKinds) brokenRow.gate_kinds = gateKinds;
      } catch {
        // keep path + error only when parsing itself fails
      }
      broken.push(brokenRow);
    }
  }

  valid.sort((a, b) => a.id.localeCompare(b.id));
  broken.sort((a, b) => a.path.localeCompare(b.path));
  return [...valid, ...broken];
}

export async function listModels(cwd: string): Promise<string[]> {
  const dir = path.join(cwd, "stages");
  const models = new Set<string>(BAKED_MODEL_IDS);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [...models].sort((a, b) => a.localeCompare(b));
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    try {
      const raw = await readYamlObject(path.join(dir, entry.name));
      if (typeof raw?.model === "string" && raw.model.trim()) {
        models.add(raw.model);
      }
    } catch {
      // ignore unreadable or invalid stage YAML
    }
  }

  return [...models].sort((a, b) => a.localeCompare(b));
}
