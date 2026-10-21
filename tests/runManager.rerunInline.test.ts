import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import {
  INLINE_PIPELINE_TOO_LARGE,
  START_PAYLOAD_MAX_BYTES,
} from "../src/runtime/startPayload.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import { loadPipelineFromObject } from "../src/config/loadPipeline.js";
import { pipelinePath } from "./helpers/fixturePaths.js";
import {
  iterateExportNdjson,
  projectRunForExport,
} from "../src/cli/exportAllCommand.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

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

function demoInline(id: string): InlinePipelineDefinition {
  return {
    id,
    stages: [
      {
        id: "plan",
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        ...REQUIRED_IO,
      },
    ],
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

describe("run manager inline pipeline rerun (U3)", () => {
  const previousMaxQueued = process.env.STAGEFLOW_MAX_QUEUED;

  beforeEach(() => {
    process.env.STAGEFLOW_MAX_QUEUED = "32";
  });

  afterEach(() => {
    if (previousMaxQueued === undefined) {
      delete process.env.STAGEFLOW_MAX_QUEUED;
    } else {
      process.env.STAGEFLOW_MAX_QUEUED = previousMaxQueued;
    }
  });

  it("inline start persists body; rerun executes same stages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rerun-inline-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      successEnvelope("1"),
      successEnvelope("2"),
    ]);
    const manager = new RunManager({ agent, cwd: fixtures, store });
    const pipeline = demoInline("inline-rerun-ok");

    const started = await manager.startRun({
      pipeline,
      task: { id: "t", goal: "inline" },
      skipGates: true,
      gitSha: "abc123",
      ciPrUrl: "https://example.com/pr/1",
      ciJobUrl: "https://example.com/job/1",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });

    const meta = await store.readRunMeta(started.runId);
    expect(meta.pipeline_source).toBe("inline");
    expect(meta.pipeline_path).toBeUndefined();
    expect(meta.skip_gates).toBe(true);
    const body = await store.readPipelineBody(started.runId);
    expect(body).toBe(JSON.stringify(pipeline));

    const rerun = await manager.rerun(started.runId);
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.runId).not.toBe(started.runId);

    await waitFor(async () => {
      const detail = await store.readRun(rerun.runId);
      return detail.status === "succeeded";
    });

    const rerunMeta = await store.readRunMeta(rerun.runId);
    expect(rerunMeta.pipeline_source).toBe("inline");
    expect(rerunMeta.skip_gates).toBe(true);
    expect(rerunMeta.git_sha).toBe("abc123");
    expect(rerunMeta.ci_pr_url).toBe("https://example.com/pr/1");
    expect(rerunMeta.ci_job_url).toBe("https://example.com/job/1");
    expect(await store.readPipelineBody(rerun.runId)).toBe(
      JSON.stringify(pipeline),
    );
  });

  it("path rerun remains unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rerun-path-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      successEnvelope("1"),
      successEnvelope("2"),
    ]);
    const manager = new RunManager({ agent, cwd: fixtures, store });

    const started = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "t", goal: "path" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });

    const meta = await store.readRunMeta(started.runId);
    expect(meta.pipeline_source).toBe("path");
    expect(meta.pipeline_path).toBeTruthy();
    expect(await store.readPipelineBody(started.runId)).toBeNull();

    const rerun = await manager.rerun(started.runId);
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(rerun.runId);
      return detail.status === "succeeded";
    });
  });

  it("legacy neither path nor body → clear 400", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rerun-legacy-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "legacy",
      taskYaml: "id: t\ngoal: g\n",
    });
    const manager = new RunManager({
      agent: scriptedFakeAgent([successEnvelope("x")]),
      cwd: fixtures,
      store,
    });
    const result = await manager.rerun(created.runId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.reason).toMatch(/neither pipeline_path nor pipeline_body/);
  });

  it("oversized inline body → inline_pipeline_too_large, no Run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rerun-big-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([successEnvelope("x")]),
      cwd: fixtures,
      store,
    });
    const pad = "x".repeat(START_PAYLOAD_MAX_BYTES);
    const pipeline: InlinePipelineDefinition = {
      id: "too-large",
      stages: [
        {
          id: "plan",
          system_prompt: pad,
          model: "anthropic/claude-sonnet-4-5",
          ...REQUIRED_IO,
        },
      ],
    };
    const before = await store.listRuns();
    const result = await manager.startRun({
      pipeline,
      task: { id: "t", goal: "big" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(INLINE_PIPELINE_TOO_LARGE);
    expect(result.status).toBe(400);
    const after = await store.listRuns();
    expect(after.length).toBe(before.length);
  });

  it("queued inline after simulated restart loads body (no missing-path cancel)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rerun-restart-"));
    const store = createRunStore({ rootDir: root });
    const pipeline = demoInline("inline-queued-restart");
    const body = JSON.stringify(pipeline);
    const loaded = await loadPipelineFromObject(pipeline, { cwd: fixtures });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const created = await store.createRun({
      pipelineId: pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: dag,
      projectRoot: fixtures,
      status: "queued",
      pipelineSource: "inline",
      pipelineBody: body,
      skipGates: true,
    });

    const manager = new RunManager({
      agent: scriptedFakeAgent([successEnvelope("restart")]),
      store,
      cwd: fixtures,
      projectRoot: fixtures,
      maxConcurrent: 1,
    });
    await manager.reenqueuePersistedQueuedRuns();

    await waitFor(async () => {
      const meta = await store.readRunMeta(created.runId);
      return meta.status === "succeeded" || meta.status === "cancelled";
    }, 15000);

    const meta = await store.readRunMeta(created.runId);
    expect(meta.status).toBe("succeeded");
    expect(meta.cancel_reason).toBeUndefined();
  }, 20000);

  it("export --all fills inline pipeline body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-export-inline-"));
    const store = createRunStore({ rootDir: root });
    const pipeline = demoInline("export-inline");
    const body = JSON.stringify(pipeline);
    const created = await store.createRun({
      pipelineId: pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineSource: "inline",
      pipelineBody: body,
    });
    const detail = await store.readRun(created.runId);
    const projected = projectRunForExport(detail, body);
    expect(projected.pipeline_source).toEqual({
      kind: "inline",
      pipeline,
    });

    const lines: string[] = [];
    for await (const line of iterateExportNdjson({ store })) {
      lines.push(line.trimEnd());
    }
    const runLine = JSON.parse(lines[1]!);
    expect(runLine.run.pipeline_source.kind).toBe("inline");
    expect(runLine.run.pipeline_source.pipeline).toEqual(pipeline);
  });
});
