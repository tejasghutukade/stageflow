import { access } from "node:fs/promises";
import { loadPipeline } from "../config/loadPipeline.js";
import type { RunMeta } from "../runstore/port.js";
import type { LoadedPipeline } from "../types/pipeline.js";

export async function loadPipelineForRun(
  meta: RunMeta,
  fallbackCwd: string,
): Promise<LoadedPipeline> {
  if (meta.pipeline_path) {
    try {
      await access(meta.pipeline_path);
    } catch {
      throw new Error(
        `Pipeline not found at stored path: ${meta.pipeline_path}`,
      );
    }
    return loadPipeline(meta.pipeline_path, {
      cwd: meta.project_root ?? fallbackCwd,
    });
  }
  return loadPipeline(meta.pipeline_id, { cwd: fallbackCwd });
}
