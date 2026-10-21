import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";

describe("run store locators", () => {
  it.each([
    {
      name: "all locator fields",
      input: {
        pipelinePath: path.resolve("/abs/pipeline.yaml"),
        taskPath: path.resolve("/abs/task.yaml"),
        projectRoot: path.resolve("/abs/project"),
      },
      expected: {
        pipeline_path: path.resolve("/abs/pipeline.yaml"),
        task_path: path.resolve("/abs/task.yaml"),
        project_root: path.resolve("/abs/project"),
      },
    },
    {
      name: "no locators when not provided on create",
      input: {},
      expected: {
        pipeline_path: undefined,
        task_path: undefined,
        project_root: undefined,
      },
    },
  ])("round-trips locators: $name", async ({ input, expected }) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-locators-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "demo",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      ...input,
    });
    const meta = await store.readRunMeta(run.runId);
    expect({
      pipeline_path: meta.pipeline_path,
      task_path: meta.task_path,
      project_root: meta.project_root,
    }).toEqual(expected);
  });

  it("persists and reads back an inline pipeline body when there is no pipeline_path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-locators-inline-"));
    const store = createRunStore({ rootDir: root });
    const inlinePipeline = {
      id: "standalone-check",
      stages: [
        {
          id: "check",
          system_prompt: "Do work",
          model: "anthropic/claude-sonnet-4-5",
          io: {
            input: { schema: { type: "object" } },
            output: { schema: { type: "object" } },
          },
        },
      ],
    };
    const run = await store.createRun({
      pipelineId: "standalone-check",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      inlinePipeline,
    });

    const meta = await store.readRunMeta(run.runId);
    expect(meta.pipeline_path).toBeUndefined();
    expect(meta.inline_pipeline).toEqual(inlinePipeline);

    // Also round-trips through listRuns, not just readRunMeta.
    const [summary] = await store.listRuns({ pipeline: "standalone-check" });
    expect(summary).toBeDefined();
  });

  it("omits inline_pipeline for a file-based (non-inline) run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-locators-non-inline-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      pipelinePath: path.resolve("/abs/pipeline.yaml"),
    });
    const meta = await store.readRunMeta(run.runId);
    expect(meta.inline_pipeline).toBeUndefined();
  });
});
