import { describe, expect, it } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

function successEnvelope(summary: string) {
  return {
    type: "emit" as const,
    envelope: {
      status: "success" as const,
      summary,
      artifacts: [],
      payload: {},
    },
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

describe("run manager inline pipeline", () => {
  it("starts and runs a pipeline authored inline, no pipeline_path stored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-inline-pipe-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([successEnvelope("done")]);
    const manager = new RunManager({ agent, cwd: fixtures, store });

    const pipeline: InlinePipelineDefinition = {
      id: "inline-run-demo",
      stages: [
        {
          id: "plan",
          system_prompt: "Do work",
          model: "anthropic/claude-sonnet-4-5",
          ...REQUIRED_IO,
        },
      ],
    };

    const result = await manager.startRun({
      pipeline,
      task: { id: "t", goal: "run inline pipeline" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(result.runId);
      return detail.status === "succeeded";
    });

    const meta = await store.readRunMeta(result.runId);
    expect(meta.pipeline_path).toBeUndefined();
    expect(meta.pipeline_id).toBe("inline-run-demo");
    expect(meta.pipeline_source).toBe("inline");
    expect(await store.readPipelineBody(result.runId)).toBe(
      JSON.stringify(pipeline),
    );
  });

  it("falls back to the host's own project root — no crash trying to derive one from an object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-inline-proj-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([successEnvelope("done")]);
    const manager = new RunManager({ agent, cwd: fixtures, store });

    const pipeline: InlinePipelineDefinition = {
      id: "inline-project-root-demo",
      stages: [
        {
          id: "plan",
          system_prompt: "Do work",
          model: "anthropic/claude-sonnet-4-5",
          ...REQUIRED_IO,
        },
      ],
    };

    const result = await manager.startRun({
      pipeline,
      task: { id: "t", goal: "run inline pipeline" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(result.runId);
      return detail.status === "succeeded";
    });

    const meta = await store.readRunMeta(result.runId);
    expect(meta.project_root).toBe(fixtures);
  });

  it("persists wire projectRoot instead of Host boot / findProjectRoot", async () => {
    const hostBoot = await mkdtemp(path.join(tmpdir(), "sf-host-boot-"));
    const wireRoot = await mkdtemp(path.join(tmpdir(), "sf-wire-root-"));
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-wire-store-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = scriptedFakeAgent([successEnvelope("done")]);
    const manager = new RunManager({
      agent,
      cwd: hostBoot,
      projectRoot: hostBoot,
      store,
    });

    const pipeline: InlinePipelineDefinition = {
      id: "wire-root-demo",
      stages: [
        {
          id: "plan",
          system_prompt: "Do work",
          model: "anthropic/claude-sonnet-4-5",
          ...REQUIRED_IO,
        },
      ],
    };

    const result = await manager.startRun({
      pipeline,
      task: { id: "t", goal: "wire root" },
      projectRoot: wireRoot,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(result.runId);
      return detail.status === "succeeded";
    });

    const meta = await store.readRunMeta(result.runId);
    expect(meta.project_root).toBe(await realpath(wireRoot));
    expect(meta.project_root).not.toBe(await realpath(hostBoot));
  });

  it("rerun on an inline-pipeline run replays the stored body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-inline-rerun-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      successEnvelope("done"),
      successEnvelope("rerun"),
    ]);
    const manager = new RunManager({ agent, cwd: fixtures, store });

    const pipeline: InlinePipelineDefinition = {
      id: "inline-rerun-demo",
      stages: [
        {
          id: "plan",
          system_prompt: "Do work",
          model: "anthropic/claude-sonnet-4-5",
          ...REQUIRED_IO,
        },
      ],
    };

    const result = await manager.startRun({
      pipeline,
      task: { id: "t", goal: "run inline pipeline" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(result.runId);
      return detail.status === "succeeded";
    });

    const meta = await store.readRunMeta(result.runId);
    expect(meta.pipeline_source).toBe("inline");
    expect(await store.readPipelineBody(result.runId)).toBe(
      JSON.stringify(pipeline),
    );

    const rerunResult = await manager.rerun(result.runId);
    expect(rerunResult.ok).toBe(true);
    if (!rerunResult.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(rerunResult.runId);
      return detail.status === "succeeded";
    });
  });
});
