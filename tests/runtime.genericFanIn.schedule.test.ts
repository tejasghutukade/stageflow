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

  it("accepted-failure diamond is ready after a failed parent settles", async () => {
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
    ).toBe(true);
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

  it("succeeded-only generic join stays blocked when the whole parent is skipped", async () => {
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
    ).toBe(false);
  });

  it("succeeded-only generic join stays blocked when every clone instance is skipped", async () => {
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
    ).toBe(false);
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

  it("skips a succeeded-only join once every predecessor is terminal and none satisfy their edge", () => {
    const dag = acceptedDiamondDag();
    dag.nodes[3] = {
      ...dag.nodes[3]!,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded"] },
      ],
    };
    // Continuation of the case above: validation has now also settled
    // (succeeded), so every predecessor edge of `synthesize` is terminal.
    // research resolved "skipped", which its succeeded-only edge can never
    // accept, so the join is permanently unsatisfiable and must be
    // force-skipped by the stalled-join sweep.
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "skipped"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    expect(pickStalledJoinSkips(dag, states)).toEqual(["synthesize"]);
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

  it("keeps a join pending across two independent, sequentially-resolving forks", async () => {
    // Regression for the exact shape that exposed the premature-skip bug in
    // production (examples/route-wiring-smoke-test/01-core-routing.pipeline.yaml):
    // two SEQUENTIAL, independent fork stages both feed one join. clarify
    // (route_select: one) resolves immediately and skip-cascades branch-a,
    // while branch-b (route_select: subset, allow_none) -- an entirely
    // separate, later-resolving fork -- is still gated/pending. join-doc's
    // three parents (branch-a directly, path-a/path-b behind branch-b) span
    // both forks, so it must stay pending until every one of them is
    // terminal, not just the first (branch-a) to resolve.
    const root = await mkdtemp(path.join(tmpdir(), "sf-two-forks-join-"));
    let releaseBranchB: () => void = () => undefined;
    const branchBGate = new Promise<void>((resolve) => {
      releaseBranchB = resolve;
    });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", { fork_choice: ["branch-b"] }),
          },
        ],
        "branch-b": [
          {
            type: "gate",
            gate: branchBGate,
            // Mirrors the production run: the second fork chooses none of
            // its own branches (allow_none: true).
            envelope: okEnvelope("branch-b-ok", { fork_choice: [] }),
          },
        ],
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
    await waitFor(async () => {
      const detail = await store.readRun(runId);
      return detail.stages.find((s) => s.stage_id === "branch-a")?.status === "skipped";
    });

    // branch-a is skip-cascaded from clarify's fork choice, but branch-b
    // (and therefore path-a/path-b) hasn't resolved yet -- join-doc must NOT
    // be decided (run or skip) yet.
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
      "skipped",
    );
    expect(detail.stages.find((s) => s.stage_id === "path-a")?.status).toBe(
      "skipped",
    );
    expect(detail.stages.find((s) => s.stage_id === "path-b")?.status).toBe(
      "skipped",
    );
    // None of join-doc's parents ever succeeded (branch-a lost the first
    // fork, path-a/path-b were never chosen by the second), so join-doc's
    // own succeeded-only edges can never be satisfied -- it's correctly
    // skipped too, but only now, after every parent across both forks
    // actually settled.
    expect(detail.stages.find((s) => s.stage_id === "join-doc")?.status).toBe(
      "skipped",
    );
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);
  });

  it("skips succeeded-only synthesize when a parent fails and fails the run", async () => {
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
      "skipped",
    );
    expect(detail.status).toBe("failed");
  });

  it("runs synthesize after an accepted parent failure and can succeed the run", async () => {
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

    await waitFor(() => (agent.openCounts.get("research") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);

    releaseValidation();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("synthesize")).toBe(1);
    const meta = await store.readRunMeta(runId);
    expect(meta.status).toBe("succeeded");
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe(
      "failed",
    );
    expect(detail.stages.find((s) => s.stage_id === "validation")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.status).toBe(
      "succeeded",
    );
    expect(detail.status).toBe("succeeded");
  });

  it("runs synthesize after a fork-skipped parent that accepts skipped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-accepted-skip-"));
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
              fork_choice: ["validation"],
            }),
          },
        ],
        research: [{ type: "throw", message: "research must stay skipped" }],
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
    expect(agent.openCounts.get("research") ?? 0).toBe(0);
    expect(agent.openCounts.get("synthesize") ?? 0).toBe(0);

    releaseValidation();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("synthesize")).toBe(1);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe(
      "skipped",
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
