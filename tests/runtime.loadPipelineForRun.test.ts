import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reloadPipelineForRun,
  reloadTaskForRun,
} from "../src/runtime/reloadRunCatalog.js";
import type { RunMeta } from "../src/runstore/port.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const owned = path.join(fixtures, "pipeline-owned", "inline-leaf");
const pipelinePath = path.join(owned, "inline.pipeline.yaml");
const taskPath = path.join(fixtures, "tasks", "sample.task.yaml");

function meta(extra: Partial<RunMeta> = {}): RunMeta {
  return {
    run_id: "run-1",
    pipeline_id: "inline-leaf",
    created_at: "2026-08-18T00:00:00.000Z",
    ...extra,
  };
}

describe("reloadRunCatalog", () => {
  it("loads pipeline from stored absolute path", async () => {
    const loaded = await reloadPipelineForRun(
      meta({ pipeline_path: pipelinePath, project_root: owned }),
    );
    expect(loaded.pipeline.id).toBe("inline-leaf");
    expect(loaded.stages.map((s) => s.id)).toEqual(["decide", "branch-a", "branch-b"]);
  });

  it("throws when stored pipeline path is missing", async () => {
    const missing = path.join(owned, "missing.pipeline.yaml");
    await expect(
      reloadPipelineForRun(
        meta({ pipeline_path: missing, project_root: owned }),
      ),
    ).rejects.toThrow(`Pipeline not found at stored path: ${missing}`);
  });

  it("rejects runs missing pipeline_path", async () => {
    await expect(
      reloadPipelineForRun(meta({ pipeline_id: "locator-fallback", project_root: owned })),
    ).rejects.toThrow(/pipeline_path/i);
  });

  it("rejects runs missing project_root", async () => {
    await expect(
      reloadPipelineForRun(meta({ pipeline_path: pipelinePath })),
    ).rejects.toThrow(/project_root/i);
  });

  it("uses project_root as loader cwd", async () => {
    const loaded = await reloadPipelineForRun(
      meta({ pipeline_path: pipelinePath, project_root: owned }),
    );
    expect(loaded.pipelinePath).toBe(path.resolve(pipelinePath));
  });

  it("loads task from stored path", async () => {
    const task = await reloadTaskForRun(
      meta({ task_path: taskPath, project_root: fixtures }),
    );
    expect(task.id).toBe("sample");
  });

  it("throws when stored task path is missing", async () => {
    const missing = path.join(fixtures, "tasks", "missing.task.yaml");
    await expect(
      reloadTaskForRun(meta({ task_path: missing, project_root: fixtures })),
    ).rejects.toThrow(`Task not found at stored path: ${missing}`);
  });
});
