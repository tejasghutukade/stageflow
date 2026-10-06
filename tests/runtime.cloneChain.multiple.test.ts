import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope, TerminalEnvelope } from "../src/types/envelope.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const issue0 = { id: "i-1", title: "First" };
const issue1 = { id: "i-2", title: "Second" };
const note0 = { id: "n-1", body: "Alpha" };
const note1 = { id: "n-2", body: "Beta" };
const batch0 = { id: "b-1", label: "Batch one" };
const batch1 = { id: "b-2", label: "Batch two" };

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

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

function schedulerStageId(input: StageRunInput): string {
  return input.stageId ?? input.stage.id;
}

function cloneChainAgent(options: {
  behaviorsByStage: Record<
    string,
    Array<
      | { type: "emit"; envelope: StageEnvelope }
      | { type: "throw"; message: string }
      | {
          type: "gate";
          gate: Promise<void>;
          envelope?: StageEnvelope;
        }
    >
  >;
}): AgentPort & {
  openCounts: Map<string, number>;
  launchOrder: string[];
  priorPayloadByStage: Map<string, unknown>;
  priorEnvelopesByStage: Map<string, StageEnvelope[] | undefined>;
} {
  const openCounts = new Map<string, number>();
  const launchOrder: string[] = [];
  const stageIndex = new Map<string, number>();
  const priorPayloadByStage = new Map<string, unknown>();
  const priorEnvelopesByStage = new Map<string, StageEnvelope[] | undefined>();

  const agent: AgentPort & {
    openCounts: Map<string, number>;
    launchOrder: string[];
    priorPayloadByStage: Map<string, unknown>;
    priorEnvelopesByStage: Map<string, StageEnvelope[] | undefined>;
  } = {
    openCounts,
    launchOrder,
    priorPayloadByStage,
    priorEnvelopesByStage,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      launchOrder.push(stageId);
      priorPayloadByStage.set(stageId, input.priorEnvelope?.payload);
      priorEnvelopesByStage.set(stageId, input.priorEnvelopes);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = options.behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? {
        type: "throw" as const,
        message: `no behavior for ${stageId} attempt ${index + 1}`,
      };
      if (behavior.type === "throw") {
        throw new Error(behavior.message);
      }
      if (behavior.type === "gate") {
        const gate = behavior.gate;
        const envelope = behavior.envelope ?? okEnvelope(stageId);
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => {
            await gate;
            return { ok: true as const, envelope };
          },
        });
      }
      return createCompletedOnlyStageHandle({
        stageId,
        run: async () => ({
          ok: true as const,
          envelope: behavior.envelope,
        }),
      });
    },
    async runStage(input) {
      const handle = agent.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
  return agent;
}

async function prepareCloneChainRun(
  root: string,
  agent: AgentPort,
  pipelineName: string,
) {
  const store = createRunStore({ rootDir: root });
  const taskPath = SAMPLE_TASK;
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const loaded = await loadPipeline(pipelinePath(pipelineName), {
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

describe("Clone Chain Join outbound and multiple chains", () => {
  it("runs the Join then schedules the next normal stage from its forward Route", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-outbound-"));
    let releaseJoin: () => void = () => undefined;
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    const agent = cloneChainAgent({
      behaviorsByStage: {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: { items: [issue0, issue1], summary: "meta" },
            }),
          },
        ],
        "handle-item~1": [
          { type: "emit", envelope: okEnvelope("item-1", { payload: { id: "i-1" } }) },
        ],
        "handle-item~2": [
          { type: "emit", envelope: okEnvelope("item-2", { payload: { id: "i-2" } }) },
        ],
        gather: [
          {
            type: "gate",
            gate: joinGate,
            envelope: okEnvelope("gathered", { payload: { digest: "all" } }),
          },
        ],
        summarize: [{ type: "emit", envelope: okEnvelope("summarized") }],
      },
    });
    const { prepared } = await prepareCloneChainRun(
      root,
      agent,
      "clone-chain-join-outbound",
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("gather") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("summarize") ?? 0).toBe(0);

    releaseJoin();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("gather")).toBe(1);
    expect(agent.openCounts.get("summarize")).toBe(1);
    expect(agent.launchOrder.indexOf("summarize")).toBeGreaterThan(
      agent.launchOrder.indexOf("gather"),
    );
    expect(agent.priorPayloadByStage.get("summarize")).toEqual({ digest: "all" });
  });

  it("mints a second Clone Chain from the Join's Clone Array", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-after-"));
    let releaseJoin: () => void = () => undefined;
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    const agent = cloneChainAgent({
      behaviorsByStage: {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: { items: [issue0, issue1], summary: "meta" },
            }),
          },
        ],
        "handle-item~1": [
          { type: "emit", envelope: okEnvelope("item-1", { payload: { id: "i-1" } }) },
        ],
        "handle-item~2": [
          { type: "emit", envelope: okEnvelope("item-2", { payload: { id: "i-2" } }) },
        ],
        gather: [
          {
            type: "gate",
            gate: joinGate,
            envelope: okEnvelope("gathered", {
              payload: { batches: [batch0, batch1] },
            }),
          },
        ],
        "handle-batch~1": [
          { type: "emit", envelope: okEnvelope("batch-1", { payload: { id: "b-1" } }) },
        ],
        "handle-batch~2": [
          { type: "emit", envelope: okEnvelope("batch-2", { payload: { id: "b-2" } }) },
        ],
        "gather-batches": [{ type: "emit", envelope: okEnvelope("gathered-batches") }],
      },
    });
    const { prepared, loaded } = await prepareCloneChainRun(
      root,
      agent,
      "clone-chain-after-chain",
    );
    const gatherNode = loaded.dag.nodes.find((node) => node.id === "gather");
    expect(gatherNode).toMatchObject({
      clone_cap: 3,
      clone_mode: "parallel",
      clone_array_field: "batches",
    });

    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 6,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("gather") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("handle-batch") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-batch~1") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-batch~2") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather-batches") ?? 0).toBe(0);

    releaseJoin();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("handle-batch")).toBeUndefined();
    expect(agent.openCounts.get("handle-batch~1")).toBe(1);
    expect(agent.openCounts.get("handle-batch~2")).toBe(1);
    expect(agent.openCounts.get("gather-batches")).toBe(1);
    expect(agent.launchOrder.indexOf("gather-batches")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-batch~1"),
    );
    expect(agent.launchOrder.indexOf("gather-batches")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-batch~2"),
    );

    expect(agent.priorPayloadByStage.get("handle-batch~1")).toEqual(batch0);
    expect(agent.priorPayloadByStage.get("handle-batch~2")).toEqual(batch1);

    const joinPriors = agent.priorEnvelopesByStage.get("gather-batches") as
      | TerminalEnvelope[]
      | undefined;
    expect(joinPriors?.map((envelope) => envelope.payload)).toEqual([
      { id: "b-1" },
      { id: "b-2" },
    ]);
  });

  it("runs two disjoint Clone Chains with independent instance cohorts and Joins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-disjoint-"));
    const agent = cloneChainAgent({
      behaviorsByStage: {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted-items", {
              payload: { items: [issue0, issue1] },
            }),
          },
        ],
        "handle-item~1": [
          { type: "emit", envelope: okEnvelope("item-1", { payload: { id: "i-1" } }) },
        ],
        "handle-item~2": [
          { type: "emit", envelope: okEnvelope("item-2", { payload: { id: "i-2" } }) },
        ],
        gather: [{ type: "emit", envelope: okEnvelope("gathered-items") }],
        "emit-notes": [
          {
            type: "emit",
            envelope: okEnvelope("emitted-notes", {
              payload: { notes: [note0, note1] },
            }),
          },
        ],
        "handle-note~1": [
          { type: "emit", envelope: okEnvelope("note-1", { payload: { id: "n-1" } }) },
        ],
        "handle-note~2": [
          { type: "emit", envelope: okEnvelope("note-2", { payload: { id: "n-2" } }) },
        ],
        "gather-notes": [{ type: "emit", envelope: okEnvelope("gathered-notes") }],
      },
    });
    const { prepared } = await prepareCloneChainRun(
      root,
      agent,
      "clone-chain-two-disjoint",
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 8,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("handle-item")).toBeUndefined();
    expect(agent.openCounts.get("handle-note")).toBeUndefined();
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2")).toBe(1);
    expect(agent.openCounts.get("handle-note~1")).toBe(1);
    expect(agent.openCounts.get("handle-note~2")).toBe(1);
    expect(agent.openCounts.get("gather")).toBe(1);
    expect(agent.openCounts.get("gather-notes")).toBe(1);

    expect(agent.priorPayloadByStage.get("handle-item~1")).toEqual(issue0);
    expect(agent.priorPayloadByStage.get("handle-item~2")).toEqual(issue1);
    expect(agent.priorPayloadByStage.get("handle-note~1")).toEqual(note0);
    expect(agent.priorPayloadByStage.get("handle-note~2")).toEqual(note1);

    expect(agent.launchOrder.indexOf("gather")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-item~1"),
    );
    expect(agent.launchOrder.indexOf("gather")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-item~2"),
    );
    expect(agent.launchOrder.indexOf("gather-notes")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-note~1"),
    );
    expect(agent.launchOrder.indexOf("gather-notes")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-note~2"),
    );
  });
});
