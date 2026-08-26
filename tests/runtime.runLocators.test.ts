import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { normalizeCatalogPath } from "../src/runstore/normalizeCatalogPath.js";
import { loadRunContext } from "../src/runtime/resumeReconstruct.js";
import { RunManager } from "../src/runtime/runManager.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import { SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const owned = path.join(fixtures, "pipeline-owned", "inline-leaf");
const pipelineFile = path.join(owned, "inline.pipeline.yaml");
const taskFile = SAMPLE_TASK;

function successEnvelope(summary: string) {
  return {
    type: "emit" as const,
    envelope: {
      status: "success" as const,
      summary,
      artifacts: [],
    },
  };
}

describe("run locator persistence", () => {
  it("createRun via startPipeline persists locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-loc-create-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      successEnvelope("1"),
      successEnvelope("2"),
      successEnvelope("3"),
    ]);

    const started = await startPipeline({
      agent,
      store,
      taskPath: taskFile,
      pipeline: pipelineFile,
      cwd: owned,
      projectRoot: root,
    });

    const meta = await store.readRunMeta(started.runId);
    expect(meta.pipeline_path).toBe(normalizeCatalogPath(pipelineFile));
    expect(meta.task_path).toBe(normalizeCatalogPath(taskFile));
    expect(meta.project_root).toBe(normalizeCatalogPath(root));

    await started.done;
  });

  it("loadRunContext uses stored pipeline path when cwd differs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-loc-ctx-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "inline-leaf",
      taskYaml: "id: sample\ngoal: test\n",
      pipelinePath: pipelineFile,
      projectRoot: owned,
    });

    const ctx = await loadRunContext(store, run.runId, "/unrelated/cwd");
    expect(ctx.loaded.pipeline.id).toBe("inline-leaf");
  });

  it("rerun succeeds after cwd change when locators are stored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-loc-rerun-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      successEnvelope("1"),
      successEnvelope("2"),
      successEnvelope("3"),
      successEnvelope("1b"),
      successEnvelope("2b"),
      successEnvelope("3b"),
    ]);

    const started = await startPipeline({
      agent,
      store,
      taskPath: taskFile,
      pipeline: pipelineFile,
      cwd: owned,
      projectRoot: root,
    });
    await started.done;

    const wrongCwd = await mkdtemp(path.join(tmpdir(), "sf-run-loc-wrong-"));
    const manager = new RunManager({ agent, cwd: wrongCwd, store, projectRoot: wrongCwd });
    const result = await manager.rerun(started.runId);
    expect(result.ok).toBe(true);

    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("loadRunContext fails clearly when stored pipeline path is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-run-loc-moved-"));
    const store = createRunStore({ rootDir: root });
    const missingPath = path.join(root, "gone.pipeline.yaml");
    const source = await store.createRun({
      pipelineId: "inline-leaf",
      taskYaml: "id: sample\ngoal: test\n",
      pipelinePath: missingPath,
      projectRoot: root,
    });

    await expect(loadRunContext(store, source.runId, fixtures)).rejects.toThrow(
      `Pipeline not found at stored path: ${missingPath}`,
    );
  });
});
