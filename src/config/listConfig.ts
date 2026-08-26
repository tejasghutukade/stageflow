import path from "node:path";
import type { StageGateKind } from "../types/stage.js";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import { loadPipeline } from "./loadPipeline.js";
import { loadTask } from "./loadTask.js";
import { scanCatalogPaths } from "./scanCatalogPaths.js";

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

export type CatalogListOptions = {
  projectRoot: string;
  manifest: LoadedManifest;
};

const BAKED_MODEL_IDS = [
  "anthropic/claude-sonnet-4-5",
  "cursor/auto",
  "cursor/composer-2-5",
] as const;

function repoRelPath(projectRoot: string, absPath: string): string {
  return path.relative(projectRoot, absPath).replace(/\\/g, "/");
}

export async function listTasks(options: CatalogListOptions): Promise<TaskListing[]> {
  const { projectRoot, manifest } = options;
  const filePaths = await scanCatalogPaths(manifest, "task");
  const listings: TaskListing[] = [];

  for (const filePath of filePaths) {
    try {
      const task = await loadTask(filePath);
      listings.push({
        path: repoRelPath(projectRoot, filePath),
        id: task.id,
        goal: task.goal,
      });
    } catch {
      // skip invalid
    }
  }

  listings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.id.localeCompare(b.id);
  });
  return listings;
}

export async function listPipelines(options: CatalogListOptions): Promise<PipelineListing[]> {
  const { projectRoot, manifest } = options;
  const filePaths = await scanCatalogPaths(manifest, "pipeline");
  const listings: PipelineListing[] = [];

  for (const filePath of filePaths) {
    try {
      const loaded = await loadPipeline(filePath, { cwd: projectRoot });
      listings.push({
        path: repoRelPath(projectRoot, filePath),
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

  listings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.id.localeCompare(b.id);
  });
  return listings;
}

export async function listStages(_options?: unknown): Promise<StageListing[]> {
  return [];
}

export async function listModels(cwd: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { readYamlObject } = await import("./readYamlObject.js");
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
