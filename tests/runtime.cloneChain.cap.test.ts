import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { assertRequiredEnvelope } from "../src/envelope/check.js";
import { assertEnvelopePayload } from "../src/envelope/payloadSchema.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import { EnvelopeError, type StageEnvelope } from "../src/types/envelope.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const issue0 = { id: "i-1", title: "First" };
const issue1 = { id: "i-2", title: "Second" };

const okEnvelope = (
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts: [],
  payload: {},
  ...extra,
});

type FakeAgentBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "never_emit" }
  | { type: "throw"; message: string };

function schedulerStageId(input: StageRunInput): string {
  return input.stageId ?? input.stage.id;
}

function stageKeyedFakeAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
): AgentPort & { openCounts: Map<string, number> } {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  return {
    openCounts,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      return scriptedFakeAgent([behavior]).openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

async function prepareCloneChainRun(
  root: string,
  agent: AgentPort,
  pipelineStem: string,
) {
  const store = createRunStore({ rootDir: root });
  const taskPath = SAMPLE_TASK;
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const loaded = await loadPipeline(pipelinePath(pipelineStem), {
    cwd: fixtures,
  });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
  return {
    prepared: {
      task,
      loaded,
      run: { runId: run.runId, workspaceDir: run.workspaceDir },
      agent,
      store,
      cwd: fixtures,
    },
    store,
    loaded,
    runId: run.runId,
  };
}

function emitterSchemaOf(loaded: Awaited<ReturnType<typeof loadPipeline>>): unknown {
  return loaded.stages.find((stage) => stage.id === "emit-items")?.payload_schema;
}

function successPayload(items: unknown[]): StageEnvelope {
  return assertRequiredEnvelope(
    okEnvelope("emitted", { payload: { items, summary: "meta" } }),
  );
}

describe("Clone Chain clone cap emit validation", () => {
  it("rejects an empty Clone Array against the compiled emitter schema", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    expect(() =>
      assertEnvelopePayload(successPayload([]), emitterSchemaOf(loaded)),
    ).toThrow(EnvelopeError);
  });

  it("rejects a Clone Array longer than clone_cap", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const overCap = [issue0, issue1, issue0, issue1, issue0];
    expect(() =>
      assertEnvelopePayload(successPayload(overCap), emitterSchemaOf(loaded)),
    ).toThrow(EnvelopeError);
  });

  it("rejects an element that does not match the named $ref", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    expect(() =>
      assertEnvelopePayload(
        successPayload([{ id: "i-1" }]),
        emitterSchemaOf(loaded),
      ),
    ).toThrow(EnvelopeError);
  });

  it("accepts a single-item Clone Array when clone_cap is 1", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-cap-1"), {
      cwd: fixtures,
    });
    expect(() =>
      assertEnvelopePayload(successPayload([issue0]), emitterSchemaOf(loaded)),
    ).not.toThrow();
    expect(() =>
      assertEnvelopePayload(successPayload([issue0, issue1]), emitterSchemaOf(loaded)),
    ).toThrow(EnvelopeError);
  });
});

describe("Clone Chain clone cap pipeline run", () => {
  it("fails the emitter on an empty Clone Array and does not mint instances or run the Join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-empty-"));
    const agent = stageKeyedFakeAgent({
      "emit-items": [
        {
          type: "emit",
          envelope: okEnvelope("emitted", {
            payload: { items: [], summary: "meta" },
          }),
        },
      ],
      "handle-item~1": [{ type: "emit", envelope: okEnvelope("item-1") }],
      gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
    });
    const { prepared, store, runId } = await prepareCloneChainRun(
      root,
      agent,
      "clone-chain-smallest",
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(agent.openCounts.get("emit-items")).toBe(1);
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~1") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    const dag = (await store.readRunMeta(runId)).pipeline_dag;
    expect(dag?.stage_ids.some((id) => id.startsWith("handle-item~"))).toBe(false);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((stage) => stage.stage_id === "emit-items")?.status).toBe(
      "failed",
    );
    expect(detail.stages.find((stage) => stage.stage_id === "gather")?.status).not.toBe(
      "succeeded",
    );
  });

  it("fails the emitter on an over-cap Clone Array without truncating or minting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-overcap-"));
    const overCap = [issue0, issue1, { id: "i-3", title: "Third" }, { id: "i-4", title: "Fourth" }, { id: "i-5", title: "Fifth" }];
    const agent = stageKeyedFakeAgent({
      "emit-items": [
        {
          type: "emit",
          envelope: okEnvelope("emitted", {
            payload: { items: overCap, summary: "meta" },
          }),
        },
      ],
      gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
    });
    const { prepared, store, runId } = await prepareCloneChainRun(
      root,
      agent,
      "clone-chain-smallest",
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(agent.openCounts.get("handle-item~1") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~5") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    const dag = (await store.readRunMeta(runId)).pipeline_dag;
    expect(dag?.stage_ids.filter((id) => id.startsWith("handle-item~"))).toEqual([]);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((stage) => stage.stage_id === "emit-items")?.status).toBe(
      "failed",
    );
  });

  it("fails the emitter when a Clone Array element does not match the named $ref", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-ref-"));
    const agent = stageKeyedFakeAgent({
      "emit-items": [
        {
          type: "emit",
          envelope: okEnvelope("emitted", {
            payload: { items: [{ id: "i-1" }], summary: "meta" },
          }),
        },
      ],
      gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
    });
    const { prepared, store, runId } = await prepareCloneChainRun(
      root,
      agent,
      "clone-chain-smallest",
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(agent.openCounts.get("handle-item~1") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    const dag = (await store.readRunMeta(runId)).pipeline_dag;
    expect(dag?.stage_ids.some((id) => id.startsWith("handle-item~"))).toBe(false);
  });

  it("mints ~1 when clone_cap is 1 and a single-item emit succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-cap1-"));
    const agent = stageKeyedFakeAgent({
      "emit-items": [
        {
          type: "emit",
          envelope: okEnvelope("emitted", {
            payload: { items: [issue0], summary: "meta" },
          }),
        },
      ],
      "handle-item~1": [
        { type: "emit", envelope: okEnvelope("item-1", { payload: { id: "i-1" } }) },
      ],
      gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
    });
    const { prepared, store, runId } = await prepareCloneChainRun(
      root,
      agent,
      "clone-chain-cap-1",
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather")).toBe(1);

    const dag = (await store.readRunMeta(runId)).pipeline_dag;
    expect(dag?.stage_ids).toContain("handle-item~1");
    expect(dag?.stage_ids).not.toContain("handle-item");
  });
});
