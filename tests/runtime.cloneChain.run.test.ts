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
) {
  const store = createRunStore({ rootDir: root });
  const taskPath = SAMPLE_TASK;
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
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

describe("Clone Chain pipeline run", () => {
  it("mints two Clone Instances from a two-element array and joins them in array order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-n2-"));
    let releaseSecond: () => void = () => undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const agent = cloneChainAgent({
      behaviorsByStage: {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: {
                items: [issue0, issue1],
                summary: "meta",
              },
            }),
          },
        ],
        "handle-item~1": [
          { type: "emit", envelope: okEnvelope("item-1", { payload: { id: "i-1" } }) },
        ],
        "handle-item~2": [
          {
            type: "gate",
            gate: secondGate,
            envelope: okEnvelope("item-2", { payload: { id: "i-2" } }),
          },
        ],
        gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
      },
    });
    const { prepared } = await prepareCloneChainRun(root, agent);
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("handle-item~1") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    releaseSecond();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("handle-item")).toBeUndefined();
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2")).toBe(1);
    expect(agent.openCounts.get("gather")).toBe(1);
    expect(agent.launchOrder.indexOf("gather")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-item~1"),
    );
    expect(agent.launchOrder.indexOf("gather")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-item~2"),
    );

    expect(agent.priorPayloadByStage.get("handle-item~1")).toEqual(issue0);
    expect(agent.priorPayloadByStage.get("handle-item~2")).toEqual(issue1);
    expect(agent.priorPayloadByStage.get("handle-item~1")).not.toHaveProperty("summary");
    expect(agent.priorPayloadByStage.get("handle-item~2")).not.toHaveProperty("items");

    const joinPriors = agent.priorEnvelopesByStage.get("gather") as
      | TerminalEnvelope[]
      | undefined;
    expect(joinPriors?.map((envelope) => envelope.payload)).toEqual([
      { id: "i-1" },
      { id: "i-2" },
    ]);
  });

  it("mints ~1 when N=1 and the Join waits on that one instance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-n1-"));
    let releaseInstance: () => void = () => undefined;
    const instanceGate = new Promise<void>((resolve) => {
      releaseInstance = resolve;
    });
    const agent = cloneChainAgent({
      behaviorsByStage: {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: {
                items: [issue0],
                summary: "meta",
              },
            }),
          },
        ],
        "handle-item~1": [
          {
            type: "gate",
            gate: instanceGate,
            envelope: okEnvelope("item-1", { payload: { id: "i-1" } }),
          },
        ],
        gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
      },
    });
    const { prepared } = await prepareCloneChainRun(root, agent);
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("handle-item~1") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~2") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    releaseInstance();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather")).toBe(1);
    expect(agent.priorPayloadByStage.get("handle-item~1")).toEqual(issue0);
    const joinPriors = agent.priorEnvelopesByStage.get("gather");
    expect(joinPriors).toHaveLength(1);
    expect(joinPriors?.[0]?.payload).toEqual({ id: "i-1" });
  });
});
