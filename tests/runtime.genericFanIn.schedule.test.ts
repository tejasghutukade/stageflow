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
import {
  cloneScheduleAllowsRun,
  pickStalledJoinSkips,
} from "../src/runtime/cloneSchedule.js";
import {
  applyForkSkipsFromEnvelopes,
  runPipelineDag,
  type StageScheduleState,
} from "../src/runtime/pipelineScheduler.js";
import { RunManager } from "../src/runtime/runManager.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import type { RunPipelineDagSnapshot } from "../src/runstore/port.js";
import type { StageEnvelope, TerminalEnvelope } from "../src/types/envelope.js";
import type { CloneForkItem } from "../src/types/forkChoice.js";
import type { ResolvedPipelineDag, ResolvedPipelineStageNode } from "../src/types/pipeline.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

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

function cloneItem(summary: string): { envelope: StageEnvelope } {
  return { envelope: okEnvelope(summary) };
}

function fanoutForks(
  mode: "parallel" | "sequential",
  summaries: string[],
): CloneForkItem[] {
  return [
    {
      successor_id: "research",
      action: "fanout",
      mode,
      clones: summaries.map(cloneItem),
    },
  ];
}

function skipResearchForks(): CloneForkItem[] {
  return [{ successor_id: "research", action: "skip" }];
}

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

function gatedFanInAgent(options: {
  behaviorsByStage: Record<
    string,
    Array<
      | { type: "emit"; envelope: StageEnvelope }
      | { type: "throw"; message: string }
      | { type: "fail"; reason: string; envelope?: StageEnvelope }
      | {
          type: "gate";
          gate: Promise<void>;
          envelope?: StageEnvelope;
          fail?: boolean;
          reason?: string;
        }
    >
  >;
}): AgentPort & {
  openCounts: Map<string, number>;
  launchOrder: string[];
  priorByStage: Map<
    string,
    Record<string, TerminalEnvelope | TerminalEnvelope[]> | undefined
  >;
} {
  const openCounts = new Map<string, number>();
  const launchOrder: string[] = [];
  const stageIndex = new Map<string, number>();
  const priorByStage = new Map<
    string,
    Record<string, TerminalEnvelope | TerminalEnvelope[]> | undefined
  >();

  const agent: AgentPort & {
    openCounts: Map<string, number>;
    launchOrder: string[];
    priorByStage: Map<
      string,
      Record<string, TerminalEnvelope | TerminalEnvelope[]> | undefined
    >;
  } = {
    openCounts,
    launchOrder,
    priorByStage,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      launchOrder.push(stageId);
      priorByStage.set(stageId, input.priorEnvelopesByStage);
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
      if (behavior.type === "fail") {
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => ({
            ok: false as const,
            reason: behavior.reason,
            ...(behavior.envelope !== undefined
              ? { envelope: behavior.envelope }
              : {}),
          }),
        });
      }
      if (behavior.type === "gate") {
        const gate = behavior.gate;
        const envelope = behavior.envelope ?? okEnvelope(stageId);
        const fail = behavior.fail;
        const reason = behavior.reason ?? "gated fail";
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => {
            await gate;
            if (fail) {
              return { ok: false as const, reason };
            }
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

async function prepareInprocessPipeline(
  root: string,
  pipelineId: string,
  agent: AgentPort,
) {
  const store = createRunStore({ rootDir: root });
  const taskPath = SAMPLE_TASK;
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const loaded = await loadPipeline(pipelinePath(pipelineId), { cwd: fixtures });
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

async function diamondCloneWithResearch(
  count: number,
): Promise<RunPipelineDagSnapshot> {
  const loaded = await loadPipeline(pipelinePath("diamond-fan-in-clone"), {
    cwd: fixtures,
  });
  const { snapshot } = appendCloneInstances(
    buildPipelineDagSnapshotFromLoaded(loaded),
    { catalogId: "research", predecessorId: "clarify", count },
  );
  return snapshot;
}

function succeededOnlyResearchJoin(
  snapshot: RunPipelineDagSnapshot,
): RunPipelineDagSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((n) =>
      n.id === "synthesize"
        ? {
            ...n,
            needsEdges: [
              { id: "research", on: ["succeeded"] },
              { id: "validation", on: ["succeeded"] },
            ],
          }
        : n,
    ),
  };
}

function acceptedDiamondDag(): ResolvedPipelineDag {
  const nodes: ResolvedPipelineStageNode[] = [
    {
      id: "clarify",
      needs: null,
      needsEdges: [],
      ancestors: [],
      stageIndex: 0,
      fork: { select: "subset", allow_none: true },
    },
    {
      id: "research",
      needs: "clarify",
      needsEdges: [{ id: "clarify", on: ["succeeded"] }],
      ancestors: ["clarify"],
      stageIndex: 1,
    },
    {
      id: "validation",
      needs: "clarify",
      needsEdges: [{ id: "clarify", on: ["succeeded"] }],
      ancestors: ["clarify"],
      stageIndex: 2,
    },
    {
      id: "synthesize",
      needs: null,
      needsEdges: [
        { id: "research", on: ["succeeded", "skipped"] },
        { id: "validation", on: ["succeeded"] },
      ],
      ancestors: ["clarify", "research", "validation"],
      stageIndex: 3,
    },
  ];
  return {
    nodes,
    roots: ["clarify"],
    childrenOf: {
      clarify: ["research", "validation"],
      research: ["synthesize"],
      validation: ["synthesize"],
      synthesize: [],
    },
  };
}

describe("generic fan-in readiness (cloneScheduleAllowsRun)", () => {
  it("legacy scalar child waits for a succeeded parent", async () => {
    const loaded = await loadPipeline(pipelinePath("parallel-after-clarify"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>(
      dag.nodes.map((n) => [n.id, "pending"]),
    );
    const envelopes = new Map<string, StageEnvelope>();
    expect(cloneScheduleAllowsRun(dag, "clarify", states, envelopes)).toBe(true);
    expect(cloneScheduleAllowsRun(dag, "design-doc", states, envelopes)).toBe(
      false,
    );
    states.set("clarify", "succeeded");
    expect(cloneScheduleAllowsRun(dag, "design-doc", states, envelopes)).toBe(
      true,
    );
    expect(
      cloneScheduleAllowsRun(dag, "implementation-plan", states, envelopes),
    ).toBe(true);
  });

  it("diamond synthesize is not a root and waits for both parents", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>(
      dag.nodes.map((n) => [n.id, "pending"]),
    );
    const envelopes = new Map<string, StageEnvelope>();
    expect(cloneScheduleAllowsRun(dag, "synthesize", states, envelopes)).toBe(
      false,
    );
    states.set("clarify", "succeeded");
    expect(cloneScheduleAllowsRun(dag, "research", states, envelopes)).toBe(
      true,
    );
    expect(cloneScheduleAllowsRun(dag, "validation", states, envelopes)).toBe(
      true,
    );
    states.set("research", "succeeded");
    expect(cloneScheduleAllowsRun(dag, "synthesize", states, envelopes)).toBe(
      false,
    );
    states.set("validation", "succeeded");
    expect(cloneScheduleAllowsRun(dag, "synthesize", states, envelopes)).toBe(
      true,
    );
  });

  it("succeeded-only diamond rejects a failed parent", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "failed"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(
      cloneScheduleAllowsRun(dag, "synthesize", states, new Map()),
    ).toBe(false);
  });

  it("failed parent keeps a multi-parent join blocked even if the edge accepts failed", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in-accepted"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "failed"],
      ["validation", "pending"],
      ["synthesize", "pending"],
    ]);
    expect(
      cloneScheduleAllowsRun(dag, "synthesize", states, new Map()),
    ).toBe(false);
    states.set("validation", "succeeded");
    expect(
      cloneScheduleAllowsRun(dag, "synthesize", states, new Map()),
    ).toBe(false);
    expect(pickStalledJoinSkips(dag, states)).toEqual([]);
  });

  it("succeeded-only generic join is ready after clone-count shrink leftovers", async () => {
    const dag = succeededOnlyResearchJoin(await diamondCloneWithResearch(2));
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research~1", "succeeded"],
      ["research~2", "skipped"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(
      cloneScheduleAllowsRun(dag, "synthesize", states, new Map()),
    ).toBe(true);
  });

  it("succeeded-only generic join runs when the whole clonable parent is skipped and a sibling succeeded", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in-clone"), {
      cwd: fixtures,
    });
    const dag = succeededOnlyResearchJoin(
      buildPipelineDagSnapshotFromLoaded(loaded),
    );
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "skipped"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(
      cloneScheduleAllowsRun(dag, "synthesize", states, new Map()),
    ).toBe(true);
  });

  it("succeeded-only generic join runs when every clone instance is skipped and a sibling succeeded", async () => {
    const dag = succeededOnlyResearchJoin(await diamondCloneWithResearch(2));
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research~1", "skipped"],
      ["research~2", "skipped"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(
      cloneScheduleAllowsRun(dag, "synthesize", states, new Map()),
    ).toBe(true);
  });

  it("scalar clone-list join is still ready after shrink leftovers", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const { snapshot } = appendCloneInstances(
      buildPipelineDagSnapshotFromLoaded(loaded),
      { catalogId: "design-doc", predecessorId: "clarify", count: 2 },
    );
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["design-doc~1", "succeeded"],
      ["design-doc~2", "skipped"],
      ["join-doc", "pending"],
    ]);
    expect(
      cloneScheduleAllowsRun(snapshot, "join-doc", states, new Map()),
    ).toBe(true);
  });

  it("scalar clone-list join stays blocked when every clone instance is skipped", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const { snapshot } = appendCloneInstances(
      buildPipelineDagSnapshotFromLoaded(loaded),
      { catalogId: "design-doc", predecessorId: "clarify", count: 2 },
    );
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["design-doc~1", "skipped"],
      ["design-doc~2", "skipped"],
      ["join-doc", "pending"],
    ]);
    expect(
      cloneScheduleAllowsRun(snapshot, "join-doc", states, new Map()),
    ).toBe(false);
  });
});

describe("generic fan-in skip cascade", () => {
  it("stops at a multi-parent join that accepts skipped", () => {
    const dag = acceptedDiamondDag();
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "pending"],
      ["validation", "pending"],
      ["synthesize", "pending"],
    ]);
    applyForkSkipsFromEnvelopes(
      dag,
      states,
      new Map([
        ["clarify", okEnvelope("ok", { fork_choice: ["validation"] })],
      ]),
    );
    expect(states.get("research")).toBe("skipped");
    expect(states.get("validation")).toBe("pending");
    expect(states.get("synthesize")).toBe("pending");
  });

  it("does not seal a succeeded-only join's fate while a sibling parent is still pending", () => {
    // Regression for the premature-skip bug: a multi-parent join must not be
    // decided off a single resolving parent. Previously this exact setup
    // (research fork-skipped, validation still pending) skipped `synthesize`
    // immediately -- sealing its fate before `validation` was even known.
    const dag = acceptedDiamondDag();
    dag.nodes[3] = {
      ...dag.nodes[3]!,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded"] },
      ],
    };
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "pending"],
      ["validation", "pending"],
      ["synthesize", "pending"],
    ]);
    applyForkSkipsFromEnvelopes(
      dag,
      states,
      new Map([
        ["clarify", okEnvelope("ok", { fork_choice: ["validation"] })],
      ]),
    );
    expect(states.get("research")).toBe("skipped");
    // validation hasn't resolved yet -- synthesize must stay pending, and the
    // stalled-join sweep (what the scheduler runs each tick) must agree
    // there's nothing to finalize yet.
    expect(states.get("validation")).toBe("pending");
    expect(states.get("synthesize")).toBe("pending");
    expect(pickStalledJoinSkips(dag, states)).toEqual([]);
  });

  it("runs a succeeded-only join once a skipped fork child and the other parents are terminal", () => {
    const dag = acceptedDiamondDag();
    dag.nodes[3] = {
      ...dag.nodes[3]!,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded"] },
      ],
    };
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "skipped"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(pickStalledJoinSkips(dag, states)).toEqual([]);
    expect(cloneScheduleAllowsRun(dag, "synthesize", states, new Map())).toBe(
      true,
    );
  });

  it("does not stalled-skip a join when a predecessor failed and every edge is terminal", () => {
    const dag = acceptedDiamondDag();
    dag.nodes[3] = {
      ...dag.nodes[3]!,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded"] },
      ],
    };
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "failed"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(pickStalledJoinSkips(dag, states)).toEqual([]);
    expect(cloneScheduleAllowsRun(dag, "synthesize", states, new Map())).toBe(
      false,
    );
  });

  it("stalled-skips a join when every parent is skipped", () => {
    const dag = acceptedDiamondDag();
    dag.nodes[3] = {
      ...dag.nodes[3]!,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded"] },
      ],
    };
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "skipped"],
      ["validation", "skipped"],
      ["synthesize", "pending"],
    ]);
    expect(pickStalledJoinSkips(dag, states)).toEqual(["synthesize"]);
    expect(cloneScheduleAllowsRun(dag, "synthesize", states, new Map())).toBe(
      false,
    );
  });

  it("does not flag a join as stalled once every predecessor settles into a satisfiable state", () => {
    const dag = acceptedDiamondDag();
    // Default acceptedDiamondDag() accepts "skipped" on the research edge,
    // so once both parents are terminal the join is ready to RUN, not skip.
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "skipped"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(pickStalledJoinSkips(dag, states)).toEqual([]);
    expect(cloneScheduleAllowsRun(dag, "synthesize", states, new Map())).toBe(
      true,
    );
  });
});

describe("generic fan-in scheduler", () => {
  it("does not launch diamond synthesize until both parents finish", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-wait-"));
    let releaseResearch: () => void = () => undefined;
    let releaseValidation: () => void = () => undefined;
    const researchGate = new Promise<void>((resolve) => {
      releaseResearch = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [{ type: "emit", envelope: okEnvelope("clarify-ok") }],
        research: [
          { type: "gate", gate: researchGate, envelope: okEnvelope("r-ok") },
        ],
        validation: [
          { type: "gate", gate: validationGate, envelope: okEnvelope("v-ok") },
        ],
        synthesize: [{ type: "emit", envelope: okEnvelope("syn-ok") }],
      },
    });
    const { prepared } = await prepareInprocessPipeline(
      root,
      "diamond-fan-in",
      agent,
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(
      () =>
        (agent.openCounts.get("research") ?? 0) === 1 &&
        (agent.openCounts.get("validation") ?? 0) === 1,
    );
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);
    expect(agent.launchOrder).not.toContain("synthesize");

    releaseResearch();
    await waitFor(() => agent.launchOrder.includes("research"));
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);

    releaseValidation();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("synthesize")).toBe(1);
    expect(agent.launchOrder.indexOf("synthesize")).toBeGreaterThan(
      agent.launchOrder.indexOf("research"),
    );
    expect(agent.launchOrder.indexOf("synthesize")).toBeGreaterThan(
      agent.launchOrder.indexOf("validation"),
    );
  });

  it("keeps a join pending across two sequential fan-outs until every parent is terminal", async () => {
    // Sequential fan-out into a join: clarify fans out to branch-a and
    // branch-b; branch-b fans out to path-a and path-b. join-doc's three
    // parents (branch-a, path-a, path-b) must all be terminal before the
    // join runs. The join runs if at least one parent succeeded.
    const root = await mkdtemp(path.join(tmpdir(), "sf-two-forks-join-"));
    let releaseBranchB: () => void = () => undefined;
    const branchBGate = new Promise<void>((resolve) => {
      releaseBranchB = resolve;
    });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [{ type: "emit", envelope: okEnvelope("clarify-ok") }],
        "branch-a": [{ type: "emit", envelope: okEnvelope("branch-a-ok") }],
        "branch-b": [
          {
            type: "gate",
            gate: branchBGate,
            envelope: okEnvelope("branch-b-ok"),
          },
        ],
        "path-a": [{ type: "emit", envelope: okEnvelope("path-a-ok") }],
        "path-b": [{ type: "emit", envelope: okEnvelope("path-b-ok") }],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "two-sequential-forks-join",
      agent,
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("branch-b") ?? 0) === 1);
    await waitFor(() => (agent.openCounts.get("branch-a") ?? 0) === 1);

    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);
    {
      const detail = await store.readRun(runId);
      expect(
        detail.stages.find((s) => s.stage_id === "join-doc")?.status,
      ).toBe("pending");
      expect(
        detail.stages.find((s) => s.stage_id === "path-a")?.status,
      ).toBe("pending");
      expect(
        detail.stages.find((s) => s.stage_id === "path-b")?.status,
      ).toBe("pending");
    }

    releaseBranchB();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");

    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "branch-a")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "path-a")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "path-b")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "join-doc")?.status).toBe(
      "succeeded",
    );
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("keeps succeeded-only synthesize pending when a parent fails and fails the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-unhandled-"));
    const store = createRunStore({ rootDir: root });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [{ type: "emit", envelope: okEnvelope("clarify-ok") }],
        research: [{ type: "fail", reason: "research boom" }],
        validation: [{ type: "emit", envelope: okEnvelope("v-ok") }],
        synthesize: [{ type: "throw", message: "synthesize must not run" }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("diamond-fan-in"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);
    const detail = await store.readRun(started.runId);
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe(
      "failed",
    );
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.status).toBe(
      "pending",
    );
    expect(detail.status).toBe("failed");
  });

  it("keeps synthesize pending after an accepted parent failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-accepted-fail-"));
    let releaseValidation: () => void = () => undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              fork_choice: ["research", "validation"],
            }),
          },
        ],
        research: [{ type: "fail", reason: "research boom" }],
        validation: [
          { type: "gate", gate: validationGate, envelope: okEnvelope("v-ok") },
        ],
        synthesize: [{ type: "throw", message: "synthesize must not run" }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "diamond-fan-in-accepted",
      agent,
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("research") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);

    releaseValidation();
    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe(
      "failed",
    );
    expect(detail.stages.find((s) => s.stage_id === "validation")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.status).toBe(
      "pending",
    );
  });

  it("runs synthesize after both fan-out parents succeed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-accepted-skip-"));
    let releaseValidation: () => void = () => undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [{ type: "emit", envelope: okEnvelope("clarify-ok") }],
        research: [{ type: "emit", envelope: okEnvelope("r-ok") }],
        validation: [
          { type: "gate", gate: validationGate, envelope: okEnvelope("v-ok") },
        ],
        synthesize: [{ type: "emit", envelope: okEnvelope("syn-ok") }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "diamond-fan-in-accepted",
      agent,
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("validation") ?? 0) === 1);
    expect(agent.openCounts.get("research") ?? 0).toBe(1);
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);

    releaseValidation();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("synthesize")).toBe(1);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.status).toBe(
      "succeeded",
    );
  });

  it("waits for every current clone instance before launching the join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-clone-wait-"));
    let releaseClone1: () => void = () => undefined;
    const clone1Gate = new Promise<void>((resolve) => {
      releaseClone1 = resolve;
    });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2"]),
            }),
          },
        ],
        "research~1": [
          { type: "gate", gate: clone1Gate, envelope: okEnvelope("r1") },
        ],
        "research~2": [{ type: "emit", envelope: okEnvelope("r2") }],
        validation: [{ type: "emit", envelope: okEnvelope("v-ok") }],
        synthesize: [{ type: "emit", envelope: okEnvelope("syn-ok") }],
      },
    });
    const { prepared } = await prepareInprocessPipeline(
      root,
      "diamond-fan-in-clone",
      agent,
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(
      () =>
        (agent.openCounts.get("research~1") ?? 0) === 1 &&
        (agent.openCounts.get("research~2") ?? 0) === 1 &&
        (agent.openCounts.get("validation") ?? 0) === 1,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);

    releaseClone1();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("synthesize")).toBe(1);
    expect(agent.launchOrder.indexOf("synthesize")).toBeGreaterThan(
      agent.launchOrder.indexOf("research~1"),
    );
    expect(agent.launchOrder.indexOf("synthesize")).toBeGreaterThan(
      agent.launchOrder.indexOf("research~2"),
    );
  });

  it("launches the join after a skipped clone definition when skipped is accepted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-clone-skip-"));
    const store = createRunStore({ rootDir: root });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: skipResearchForks(),
            }),
          },
        ],
        research: [{ type: "throw", message: "research definition must not run" }],
        validation: [{ type: "emit", envelope: okEnvelope("v-ok") }],
        synthesize: [{ type: "emit", envelope: okEnvelope("syn-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("diamond-fan-in-clone"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    expect(agent.openCounts.get("research") ?? 0).toBe(0);
    expect(agent.openCounts.get("synthesize")).toBe(1);
    const detail = await store.readRun(started.runId);
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe(
      "skipped",
    );
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.status).toBe(
      "succeeded",
    );
  });
});

describe("route if join", () => {
  it("does not launch or skip the join while a sibling parent is still running after a false if", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "pending"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: false } })],
    ]);
    expect(cloneScheduleAllowsRun(dag, "assemble", states, envelopes)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("runs the join when every parent succeeded and every inbound if fired", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "succeeded"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: true } })],
      ["draw", okEnvelope("draw-ok", { payload: { complete: true } })],
    ]);
    expect(cloneScheduleAllowsRun(dag, "assemble", states, envelopes)).toBe(
      true,
    );
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("stalled-skips the join when every parent succeeded but an inbound if missed", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "succeeded"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: true } })],
      ["draw", okEnvelope("draw-ok", { payload: { complete: false } })],
    ]);
    expect(cloneScheduleAllowsRun(dag, "assemble", states, envelopes)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual(["assemble"]);
  });

  it("does not stalled-skip a join when a parent failed even if the other if would miss", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "failed"],
      ["draw", "succeeded"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["draw", okEnvelope("draw-ok", { payload: { complete: false } })],
    ]);
    expect(cloneScheduleAllowsRun(dag, "assemble", states, envelopes)).toBe(
      false,
    );
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });
});

describe("route if join scheduler", () => {
  it("keeps the join pending after a false if until the other parent is terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-join-wait-"));
    let releaseDraw: () => void = () => undefined;
    const drawGate = new Promise<void>((resolve) => {
      releaseDraw = resolve;
    });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        kickoff: [{ type: "emit", envelope: okEnvelope("kickoff-ok") }],
        write: [
          {
            type: "emit",
            envelope: okEnvelope("write-ok", { payload: { ready: false } }),
          },
        ],
        draw: [
          {
            type: "gate",
            gate: drawGate,
            envelope: okEnvelope("draw-ok", { payload: { complete: true } }),
          },
        ],
        assemble: [{ type: "throw", message: "assemble must not run" }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "route-if-join",
      agent,
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("write") ?? 0) === 1);
    await waitFor(() => (agent.openCounts.get("draw") ?? 0) === 1);
    await waitFor(async () => {
      const detail = await store.readRun(runId);
      return (
        detail.stages.find((s) => s.stage_id === "write")?.status ===
        "succeeded"
      );
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("assemble") ?? 0).toBe(0);
    {
      const detail = await store.readRun(runId);
      expect(detail.stages.find((s) => s.stage_id === "assemble")?.status).toBe(
        "pending",
      );
    }

    releaseDraw();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("assemble") ?? 0).toBe(0);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "assemble")?.status).toBe(
      "skipped",
    );
  });

  it("runs the join with both success envelopes when every inbound if fired", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-join-fire-"));
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        kickoff: [{ type: "emit", envelope: okEnvelope("kickoff-ok") }],
        write: [
          {
            type: "emit",
            envelope: okEnvelope("write-ok", { payload: { ready: true } }),
          },
        ],
        draw: [
          {
            type: "emit",
            envelope: okEnvelope("draw-ok", { payload: { complete: true } }),
          },
        ],
        assemble: [{ type: "emit", envelope: okEnvelope("assemble-ok") }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "route-if-join",
      agent,
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("assemble")).toBe(1);
    const priors = agent.priorByStage.get("assemble");
    expect(priors?.write).toMatchObject({ payload: { ready: true } });
    expect(priors?.draw).toMatchObject({ payload: { complete: true } });
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "assemble")?.status).toBe(
      "succeeded",
    );
  });

  it("skips the join when every parent succeeded but one inbound if missed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-join-miss-"));
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        kickoff: [{ type: "emit", envelope: okEnvelope("kickoff-ok") }],
        write: [
          {
            type: "emit",
            envelope: okEnvelope("write-ok", { payload: { ready: true } }),
          },
        ],
        draw: [
          {
            type: "emit",
            envelope: okEnvelope("draw-ok", { payload: { complete: false } }),
          },
        ],
        assemble: [{ type: "throw", message: "assemble must not run" }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "route-if-join",
      agent,
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("assemble") ?? 0).toBe(0);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "assemble")?.status).toBe(
      "skipped",
    );
    expect(detail.status).toBe("succeeded");
  });

  it("keeps the join pending when a parent failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-join-fail-"));
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        kickoff: [{ type: "emit", envelope: okEnvelope("kickoff-ok") }],
        write: [{ type: "fail", reason: "write boom" }],
        draw: [
          {
            type: "emit",
            envelope: okEnvelope("draw-ok", { payload: { complete: true } }),
          },
        ],
        assemble: [{ type: "throw", message: "assemble must not run" }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "route-if-join",
      agent,
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(agent.openCounts.get("assemble") ?? 0).toBe(0);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "write")?.status).toBe(
      "failed",
    );
    expect(detail.stages.find((s) => s.stage_id === "assemble")?.status).toBe(
      "pending",
    );
  });
});

