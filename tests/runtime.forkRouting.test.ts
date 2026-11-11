import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sqliteConnectionFromStore, createRunStore } from "../src/runstore/createStore.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { RunManager } from "../src/runtime/runManager.js";
import {
  applyForkSkipsFromEnvelopes,
  hydrateScheduleFromStore,
  hydrateScheduleForRetryRoots,
  resumeRun,
  runPipelineDag,
  type StageScheduleState,
} from "../src/runtime/pipelineScheduler.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { ResolvedPipelineDag, ResolvedPipelineStageNode } from "../src/types/pipeline.js";
import { failEnvelope, okEnvelope } from "./helpers/envelopes.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";
import { stageKeyedAgent } from "./helpers/stageKeyedAgent.js";
import { waitFor } from "./helpers/waitFor.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function buildDag(
  entries: Array<{ id: string; needs?: string; fork?: ResolvedPipelineStageNode["fork"] }>,
): ResolvedPipelineDag {
  const nodes: ResolvedPipelineStageNode[] = entries.map((e, i) => ({
    id: e.id,
    needs: e.needs ?? null,
    ancestors: e.needs ? [e.needs] : [],
    stageIndex: i,
    ...(e.fork ? { fork: e.fork } : {}),
  }));

  const childrenOf: Record<string, string[]> = {};
  for (const node of nodes) {
    if (node.needs) {
      childrenOf[node.needs] = [...(childrenOf[node.needs] ?? []), node.id];
    }
  }

  const roots = nodes.filter((n) => !n.needs).map((n) => n.id);
  return { nodes, roots, childrenOf };
}

// ─── Section 1: applyForkSkipsFromEnvelopes unit tests ─────────────────────

type DagEntry = Parameters<typeof buildDag>[0][number];
type ScheduleState = StageScheduleState;

const oneFork = { select: "one", allow_none: false } as const;
const fanOut: DagEntry[] = [
  { id: "design-doc", needs: "clarify" },
  { id: "implementation-plan", needs: "clarify" },
];
const fanOutWithJoin: DagEntry[] = [
  ...fanOut,
  { id: "join-doc", needs: "implementation-plan" },
];

describe("applyForkSkipsFromEnvelopes", () => {
  it.each<{
    name: string;
    entries: DagEntry[];
    states: Record<string, ScheduleState>;
    envelope?: StageEnvelope;
    passes?: number;
    expected: Record<string, ScheduleState>;
  }>([
    {
      name: "unchosen child skipped, chosen child untouched",
      entries: [{ id: "clarify", fork: oneFork }, ...fanOut],
      states: { "design-doc": "pending", "implementation-plan": "pending" },
      envelope: okEnvelope("ok", { fork_choice: ["design-doc"] }),
      expected: { "design-doc": "pending", "implementation-plan": "skipped" },
    },
    {
      name: "cascade: unchosen child pending descendants also skipped",
      entries: [{ id: "clarify", fork: oneFork }, ...fanOutWithJoin],
      states: {
        "design-doc": "pending",
        "implementation-plan": "pending",
        "join-doc": "pending",
      },
      envelope: okEnvelope("ok", { fork_choice: ["design-doc"] }),
      expected: {
        "design-doc": "pending",
        "implementation-plan": "skipped",
        "join-doc": "skipped",
      },
    },
    {
      name: "unchosen child already succeeded: child stays succeeded, pending descendants skipped",
      entries: [{ id: "clarify", fork: oneFork }, ...fanOutWithJoin],
      states: {
        "design-doc": "pending",
        "implementation-plan": "succeeded",
        "join-doc": "pending",
      },
      envelope: okEnvelope("ok", { fork_choice: ["design-doc"] }),
      expected: {
        "design-doc": "pending",
        "implementation-plan": "succeeded",
        "join-doc": "skipped",
      },
    },
    {
      name: "fork stage has no envelope: no state change",
      entries: [{ id: "clarify", fork: oneFork }, ...fanOut],
      states: { "design-doc": "pending", "implementation-plan": "pending" },
      expected: { "design-doc": "pending", "implementation-plan": "pending" },
    },
    {
      name: "non-fork stage with envelope: no state change",
      entries: [{ id: "clarify" }, ...fanOut],
      states: { "design-doc": "pending", "implementation-plan": "pending" },
      envelope: okEnvelope("ok", { fork_choice: ["design-doc"] }),
      expected: { "design-doc": "pending", "implementation-plan": "pending" },
    },
    {
      name: "empty fork_choice: all children skipped",
      entries: [
        { id: "clarify", fork: { select: "subset", allow_none: true } },
        ...fanOut,
      ],
      states: { "design-doc": "pending", "implementation-plan": "pending" },
      envelope: okEnvelope("ok", { fork_choice: [] }),
      expected: { "design-doc": "skipped", "implementation-plan": "skipped" },
    },
    {
      name: "undefined fork_choice treated as empty: all children skipped",
      entries: [
        { id: "clarify", fork: { select: "subset", allow_none: false } },
        ...fanOut,
      ],
      states: { "design-doc": "pending", "implementation-plan": "pending" },
      envelope: okEnvelope("ok"),
      expected: { "design-doc": "skipped", "implementation-plan": "skipped" },
    },
    {
      name: "idempotent: calling twice produces same result",
      entries: [{ id: "clarify", fork: oneFork }, ...fanOutWithJoin],
      states: {
        "design-doc": "pending",
        "implementation-plan": "pending",
        "join-doc": "pending",
      },
      envelope: okEnvelope("ok", { fork_choice: ["design-doc"] }),
      passes: 2,
      expected: {
        "design-doc": "pending",
        "implementation-plan": "skipped",
        "join-doc": "skipped",
      },
    },
  ])("$name", ({ entries, states, envelope, passes = 1, expected }) => {
    const dag = buildDag(entries);
    const stateMap = new Map<string, ScheduleState>([
      ["clarify", "succeeded"],
      ...Object.entries(states),
    ]);
    const completed = new Map<string, StageEnvelope>(
      envelope ? [["clarify", envelope]] : [],
    );

    for (let i = 0; i < passes; i += 1) {
      applyForkSkipsFromEnvelopes(dag, stateMap, completed);
    }

    expect(Object.fromEntries(stateMap)).toEqual({
      clarify: "succeeded",
      ...expected,
    });
  });

  it("stored fork_choice skip and if-skip do not clobber each other on a legacy forked snapshot", () => {
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "clarify",
          needs: null,
          needsEdges: [],
          ancestors: [],
          stageIndex: 0,
          fork: { select: "one", allow_none: false },
        },
        {
          id: "design-doc",
          needs: "clarify",
          needsEdges: [
            {
              id: "clarify",
              on: ["succeeded"],
              if: { field: "ok", op: "eq", value: true },
            },
          ],
          ancestors: ["clarify"],
          stageIndex: 1,
        },
        {
          id: "implementation-plan",
          needs: "clarify",
          needsEdges: [{ id: "clarify", on: ["succeeded"] }],
          ancestors: ["clarify"],
          stageIndex: 2,
        },
      ],
      roots: ["clarify"],
      childrenOf: { clarify: ["design-doc", "implementation-plan"] },
    };
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "skipped" as const],
      ["implementation-plan", "pending" as const],
    ]);

    applyForkSkipsFromEnvelopes(
      dag,
      states,
      new Map([
        [
          "clarify",
          okEnvelope("ok", {
            fork_choice: ["design-doc"],
            payload: { ok: false },
          }),
        ],
      ]),
    );

    expect(states.get("design-doc")).toBe("skipped");
    expect(states.get("implementation-plan")).toBe("skipped");
  });
});

// ─── Section 2: Integration tests ──────────────────────────────────────────

describe("fork routing integration", () => {
  it.each([
    {
      name: "route chain through a join",
      pipeline: "fork-route-cascade",
      clarifyExtra: {},
      opened: ["design-doc", "implementation-plan", "join-doc"],
    },
    {
      name: "route listing three successors",
      pipeline: "fork-route-subset",
      clarifyExtra: {},
      opened: ["design-doc", "implementation-plan", "join-doc"],
    },
    {
      name: "route ignores an empty fork_choice",
      pipeline: "fork-route-allow-none",
      clarifyExtra: { fork_choice: [] },
      opened: ["design-doc", "implementation-plan"],
    },
  ])(
    "catalog fan-out runs every listed successor: $name",
    async ({ pipeline, clarifyExtra, opened }) => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-fork-fanout-"));
      const store = createRunStore({ rootDir: root });
      const agent = stageKeyedAgent({
        clarify: [
          { type: "emit", envelope: okEnvelope("clarify-ok", clarifyExtra) },
        ],
        "design-doc": [{ type: "emit", envelope: okEnvelope("design-ok") }],
        "implementation-plan": [
          { type: "emit", envelope: okEnvelope("impl-ok") },
        ],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      });

      const manager = new RunManager({ agent, store, cwd: fixtures });
      const started = await manager.startRun({
        task: SAMPLE_TASK,
        pipeline: pipelinePath(pipeline),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "succeeded";
      });

      expect(agent.openCounts.get("clarify")).toBe(1);
      for (const stageId of opened) {
        expect(agent.openCounts.get(stageId)).toBe(1);
      }
      expect(agent.openCounts.get("join-doc") ?? 0).toBe(
        opened.includes("join-doc") ? 1 : 0,
      );

      const detail = await store.readRun(started.runId);
      expect(detail.status).toBe("succeeded");
    },
  );

  it("AE8: retry after failure then fans out all listed successors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-ae8-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [
        { type: "emit", envelope: failEnvelope("clarify-fail") },
        {
          type: "emit",
          envelope: okEnvelope("clarify-retry"),
        },
      ],
      "design-doc": [{ type: "emit", envelope: okEnvelope("design-ok") }],
      "implementation-plan": [{ type: "emit", envelope: okEnvelope("impl-ok") }],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("fork-route-cascade"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const retry = await manager.retryStage(started.runId, "clarify");
    expect(retry.ok).toBe(true);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    expect(agent.openCounts.get("clarify")).toBe(2);
    expect(agent.openCounts.get("design-doc")).toBe(1);
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
  }, 15000);

  it("AE8-success-retry: retry of a succeeded fan-out parent re-runs listed successors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-ae8-sr-"));
    const store = createRunStore({ rootDir: root });

    const taskYaml = await readFile(
      SAMPLE_TASK,
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "fork-route-cascade",
      taskYaml,
      taskId: "sample",
    });

    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.createStageExecution(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.writeEnvelope(
      run.runId,
      "clarify",
      okEnvelope("clarify-chose-design", { fork_choice: ["design-doc"] }),
    );

    await store.ensureStageWorkspace(run.runId, "design-doc");
    await store.createStageExecution(run.runId, "design-doc");
    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    await store.appendStageEvent(run.runId, "design-doc", { event: "succeeded" });
    await store.writeEnvelope(run.runId, "design-doc", okEnvelope("design-ok"));

    await store.updateRunStatus(run.runId, "succeeded");

    const loaded = await loadPipeline(pipelinePath("fork-route-cascade"), { cwd: fixtures });
    const workspaceDir = store.getWorkspaceDir(run.runId);
    const task = loadTaskFromYaml(taskYaml, "sample");

    const hydrated = await hydrateScheduleForRetryRoots(
      store,
      run.runId,
      loaded.dag,
      ["clarify"],
    );

    const agent = stageKeyedAgent({
      clarify: [
        {
          type: "emit",
          envelope: okEnvelope("clarify-retry"),
        },
      ],
      "design-doc": [{ type: "emit", envelope: okEnvelope("design-retry") }],
      "implementation-plan": [{ type: "emit", envelope: okEnvelope("impl-ok") }],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
    });

    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir },
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      initialSchedule: hydrated,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("clarify")).toBe(1);
    expect(agent.openCounts.get("design-doc")).toBe(1);
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("AE-hydration: catalog fan-out runs all listed successors from stored envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-hydration-"));
    const store = createRunStore({ rootDir: root });

    const taskYaml = await readFile(
      SAMPLE_TASK,
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "fork-route-cascade",
      taskYaml,
      taskId: "sample",
    });

    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.createStageExecution(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.writeEnvelope(
      run.runId,
      "clarify",
      okEnvelope("clarify-ok"),
    );
    await store.updateRunStatus(run.runId, "running");

    const task = loadTaskFromYaml(taskYaml, "sample");
    const loaded = await loadPipeline(pipelinePath("fork-route-cascade"), { cwd: fixtures });
    const workspaceDir = store.getWorkspaceDir(run.runId);

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    const agent = stageKeyedAgent({
      "design-doc": [{ type: "emit", envelope: okEnvelope("design-ok") }],
      "implementation-plan": [{ type: "emit", envelope: okEnvelope("impl-ok") }],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
    });

    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir },
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      initialSchedule: hydrated,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("design-doc")).toBe(1);
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });
});

describe("forward route if eq scheduling", () => {
  it("missing_field halts with today's reason string", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-missing-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath("route-if-eq"), {
      cwd: fixtures,
    });
    loaded.dag = {
      ...loaded.dag,
      nodes: loaded.dag.nodes.map((node) =>
        node.id === "page"
          ? {
              ...node,
              needsEdges: node.needsEdges.map((edge) =>
                edge.id === "triage"
                  ? {
                      ...edge,
                      if: { field: "absent", op: "eq", value: true },
                    }
                  : edge,
              ),
            }
          : node,
      ),
    };
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    });
    const agent = stageKeyedAgent({
      triage: [
        {
          type: "emit",
          envelope: okEnvelope("triage-ok", { payload: { severity: "high" } }),
        },
      ],
      page: [{ type: "throw", message: "page must not run" }],
      notify: [{ type: "throw", message: "notify must not run" }],
    });

    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir: run.workspaceDir },
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe(
      'stage "triage": route if field missing from payload',
    );
    expect(agent.openCounts.get("page") ?? 0).toBe(0);
    expect(agent.openCounts.get("notify") ?? 0).toBe(0);
  });

  it.each([
    {
      name: "matching payload runs the gated target",
      pipeline: "route-if-eq",
      payload: { severity: "high" },
      page: "succeeded",
    },
    {
      name: "non-matching payload skips the gated target and still runs the always-run sibling",
      pipeline: "route-if-eq",
      payload: { severity: "low" },
      page: "skipped",
    },
    {
      name: "two matching ifs on different targets both run",
      pipeline: "route-if-two-match",
      payload: { severity: "high", escalate: true },
      page: "succeeded",
    },
    {
      name: "composition miss skips the gated target and the run succeeds",
      pipeline: "route-if-composition",
      payload: { severity: "low", source: "web" },
      page: "skipped",
    },
    {
      name: "composition match runs the gated target",
      pipeline: "route-if-composition",
      payload: { severity: "high", source: "web" },
      page: "succeeded",
    },
  ] as const)("$name", async ({ pipeline, payload, page }) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      triage: [
        { type: "emit", envelope: okEnvelope("triage-ok", { payload }) },
      ],
      page: [{ type: "emit", envelope: okEnvelope("page-ok") }],
      notify: [{ type: "emit", envelope: okEnvelope("notify-ok") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath(pipeline),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded" || meta.status === "failed";
    });

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
    expect(detail.stages.find((s) => s.stage_id === "page")?.status).toBe(page);
    expect(detail.stages.find((s) => s.stage_id === "notify")?.status).toBe(
      "succeeded",
    );
    expect(agent.openCounts.get("page")).toBe(page === "succeeded" ? 1 : undefined);
    expect(agent.openCounts.get("notify")).toBe(1);
  });
});

describe("resume after exclusive route-if", () => {
  it("live startRun skips the unused exclusive sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-excl-live-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      decide: [
        {
          type: "emit",
          envelope: okEnvelope("decide-ok", { payload: { branch: "branch-a" } }),
        },
      ],
      "branch-a": [{ type: "emit", envelope: okEnvelope("branch-a-ok") }],
      "branch-b": [{ type: "emit", envelope: okEnvelope("branch-b-ok") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("route-if-exclusive"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded" || meta.status === "failed";
    });

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
    expect(detail.stages.find((s) => s.stage_id === "branch-a")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "branch-b")?.status).toBe(
      "skipped",
    );
    expect(agent.openCounts.get("branch-a")).toBe(1);
    expect(agent.openCounts.get("branch-b")).toBeUndefined();
  });

  it("resumeRun after decide success skips the unused exclusive sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-route-if-excl-resume-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath("route-if-exclusive"), {
      cwd: fixtures,
    });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    });

    const envelope = okEnvelope("decide-ok", { payload: { branch: "branch-a" } });
    await store.ensureStageWorkspace(run.runId, "decide");
    await store.createStageExecution(run.runId, "decide");
    await store.appendStageEvent(run.runId, "decide", { event: "started" });
    await store.appendStageEvent(run.runId, "decide", { event: "succeeded" });
    await store.writeEnvelope(run.runId, "decide", envelope);
    await store.updateRunStatus(run.runId, "running");

    const agent = stageKeyedAgent({
      "branch-a": [{ type: "emit", envelope: okEnvelope("branch-a-ok") }],
      "branch-b": [{ type: "emit", envelope: okEnvelope("branch-b-ok") }],
    });

    const result = await resumeRun({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir: run.workspaceDir },
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      resumeFromStageId: "decide",
      initialPrior: envelope,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(result.reason).toBeUndefined();
    const detail = await store.readRun(run.runId);
    expect(detail.stages.find((s) => s.stage_id === "branch-a")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "branch-b")?.status).toBe(
      "skipped",
    );
    expect(agent.openCounts.get("branch-a")).toBe(1);
    expect(agent.openCounts.get("branch-b")).toBeUndefined();
  });
});

type RouteCall = {
  stageId: string;
  runId: string;
  children: Array<{ id: string; name: string }>;
  envelope: StageEnvelope;
};

function routeInvoker(
  select: (call: RouteCall) => unknown,
  probe?: (call: RouteCall) => Promise<void>,
) {
  const calls: RouteCall[] = [];
  return {
    calls,
    async invoke(call: RouteCall) {
      calls.push(call);
      if (probe) await probe(call);
      return { ok: true as const, value: select(call) };
    },
  };
}

async function installPick(root: string, store: ReturnType<typeof createRunStore>) {
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("run store has no connection");
  await new FunctionService({ store: new FunctionStore(db) }).create(
    root,
    {
      id: "pick",
      name: "Pick",
      kind: "routing",
      source: "export default function execute() {\n  return { nextStageIds: [] };\n}\n",
      capabilities: [],
      bindings: [],
    },
    { source: "file" },
  );
}

function attachRoute(loaded: Awaited<ReturnType<typeof loadPipeline>>, stageId: string) {
  const node = loaded.dag.nodes.find((item) => item.id === stageId);
  if (!node) throw new Error(`missing ${stageId}`);
  (node as { routeFunction?: { id: string; grants: [] } }).routeFunction = {
    id: "pick",
    grants: [],
  };
}

describe("function route", () => {
  async function preparedRun(
    pipeline: string,
    agent: ReturnType<typeof stageKeyedAgent>,
    invoker: ReturnType<typeof routeInvoker>,
    mutate?: (loaded: Awaited<ReturnType<typeof loadPipeline>>) => void,
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fn-route-"));
    const store = createRunStore({ rootDir: root });
    await installPick(root, store);
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath(pipeline), {
      cwd: root,
      projectRoot: root,
    });
    mutate?.(loaded);
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    });
    const prepared = {
      task,
      loaded,
      run: { runId: run.runId, workspaceDir: run.workspaceDir },
      agent,
      store,
      cwd: root,
      projectRoot: root,
    };
    return { root, store, loaded, run, prepared, invoker };
  }

  async function runRouted(
    pipeline: string,
    behaviors: Parameters<typeof stageKeyedAgent>[0],
    select: (call: RouteCall) => unknown,
    mutate?: (loaded: Awaited<ReturnType<typeof loadPipeline>>) => void,
    probe?: (call: RouteCall, store: ReturnType<typeof createRunStore>) => Promise<void>,
  ) {
    const invoker = routeInvoker(select);
    const setup = await preparedRun(
      pipeline,
      stageKeyedAgent(behaviors, {
        stageKey: (input) => input.stageId ?? input.stage.id,
      }),
      invoker,
      mutate,
    );
    if (probe) {
      const original = invoker.invoke.bind(invoker);
      invoker.invoke = async (call) => {
        await probe(call, setup.store);
        return original(call);
      };
    }
    const result = await runPipelineDag({
      prepared: setup.prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      functionRouteInvoker: invoker,
    });
    return { ...setup, result };
  }

  it("two eligible ids schedule both children", async () => {
    const { result, store, run, invoker, prepared } = await runRouted(
      "function-route",
      {
        choose: [{ type: "emit", envelope: okEnvelope("choose-ok") }],
        left: [{ type: "emit", envelope: okEnvelope("left-ok") }],
        right: [{ type: "emit", envelope: okEnvelope("right-ok") }],
      },
      () => ({ nextStageIds: ["left", "right"] }),
    );
    expect(result.ok).toBe(true);
    expect(invoker.calls).toHaveLength(1);
    expect(invoker.calls[0]?.children.map((child) => child.id).sort()).toEqual([
      "left",
      "right",
    ]);
    expect(prepared.agent.openCounts.get("left")).toBe(1);
    expect(prepared.agent.openCounts.get("right")).toBe(1);
    const execution = await store.getLatestStageExecution(run.runId, "choose");
    expect(execution?.envelope?.fork_choice).toBeUndefined();
    expect(
      (execution as { function_route?: { status: string; nextStageIds: string[] } } | null)
        ?.function_route,
    ).toEqual({ status: "selected", nextStageIds: ["left", "right"] });
  });

  it("an empty selection finishes that branch", async () => {
    const { result, prepared } = await runRouted(
      "function-route",
      {
        choose: [{ type: "emit", envelope: okEnvelope("choose-ok") }],
        left: [{ type: "throw", message: "left must not run" }],
        right: [{ type: "throw", message: "right must not run" }],
      },
      () => ({ nextStageIds: [] }),
    );
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(prepared.agent.openCounts.get("left") ?? 0).toBe(0);
    expect(prepared.agent.openCounts.get("right") ?? 0).toBe(0);
    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.stages.find((stage) => stage.stage_id === "left")?.status).toBe("skipped");
    expect(detail.stages.find((stage) => stage.stage_id === "right")?.status).toBe("skipped");
  });

  it.each(["duplicate", "unknown"] as const)(
    "a %s id fails routing and schedules nothing",
    async (kind) => {
      const { result, prepared, store, run } = await runRouted(
        "function-route",
        {
          choose: [{ type: "emit", envelope: okEnvelope("choose-ok") }],
          left: [{ type: "throw", message: "left must not run" }],
          right: [{ type: "throw", message: "right must not run" }],
        },
        () => ({ nextStageIds: kind === "duplicate" ? ["left", "left"] : ["missing"] }),
      );
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("failed");
      expect(prepared.agent.openCounts.get("choose")).toBe(1);
      expect(prepared.agent.openCounts.get("left") ?? 0).toBe(0);
      expect(prepared.agent.openCounts.get("right") ?? 0).toBe(0);
      const execution = await store.getLatestStageExecution(run.runId, "choose");
      expect(
        (execution as { function_route?: { status: string } } | null)?.function_route?.status,
      ).toBe("error");
      expect(execution?.envelope?.fork_choice).toBeUndefined();
    },
  );

  it("a crash after the decision is stored resumes without calling the function", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fn-route-stored-"));
    const store = createRunStore({ rootDir: root });
    await installPick(root, store);
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath("function-route"), {
      cwd: root,
      projectRoot: root,
    });
    const envelope = okEnvelope("choose-ok");
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    });
    await store.createStageExecution(run.runId, "choose");
    await store.appendStageEvent(run.runId, "choose", { event: "started" });
    await store.appendStageEvent(run.runId, "choose", { event: "succeeded" });
    await store.writeEnvelope(run.runId, "choose", envelope);
    await store.updateStageExecution(run.runId, "choose", 1, {
      function_route: { status: "selected", nextStageIds: ["left"] },
    } as never);
    await store.updateRunStatus(run.runId, "running");
    const agent = stageKeyedAgent({
      left: [{ type: "emit", envelope: okEnvelope("left-ok") }],
      right: [{ type: "throw", message: "right must not run" }],
    });
    const invoker = routeInvoker(() => ({ nextStageIds: ["left", "right"] }));
    const result = await resumeRun({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir: run.workspaceDir },
        agent,
        store,
        cwd: root,
        projectRoot: root,
      },
      maxActiveStagesPerRun: 4,
      resumeFromStageId: "choose",
      initialPrior: envelope,
      executionMode: "inprocess",
      functionRouteInvoker: invoker,
    });
    expect(result.ok).toBe(true);
    expect(invoker.calls).toHaveLength(0);
    expect(agent.openCounts.get("choose") ?? 0).toBe(0);
    expect(agent.openCounts.get("left")).toBe(1);
    expect(agent.openCounts.get("right") ?? 0).toBe(0);
  });

  it("a crash after success and before the decision retries routing once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fn-route-missing-"));
    const store = createRunStore({ rootDir: root });
    await installPick(root, store);
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath("function-route"), {
      cwd: root,
      projectRoot: root,
    });
    const envelope = okEnvelope("choose-ok");
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    });
    await store.createStageExecution(run.runId, "choose");
    await store.appendStageEvent(run.runId, "choose", { event: "started" });
    await store.appendStageEvent(run.runId, "choose", { event: "succeeded" });
    await store.writeEnvelope(run.runId, "choose", envelope);
    await store.updateRunStatus(run.runId, "running");
    const agent = stageKeyedAgent({
      left: [{ type: "emit", envelope: okEnvelope("left-ok") }],
      right: [{ type: "throw", message: "right must not run" }],
    });
    const childEventsAtInvoke: number[] = [];
    const invoker = routeInvoker(
      () => ({ nextStageIds: ["left"] }),
      async () => {
        const left = await store.listStageEvents(run.runId, "left");
        const right = await store.listStageEvents(run.runId, "right");
        childEventsAtInvoke.push(left.length + right.length);
      },
    );
    const result = await resumeRun({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir: run.workspaceDir },
        agent,
        store,
        cwd: root,
        projectRoot: root,
      },
      maxActiveStagesPerRun: 4,
      resumeFromStageId: "choose",
      initialPrior: envelope,
      executionMode: "inprocess",
      functionRouteInvoker: invoker,
    });
    expect(result.ok).toBe(true);
    expect(invoker.calls).toHaveLength(1);
    expect(childEventsAtInvoke).toEqual([0]);
    expect(agent.openCounts.get("choose") ?? 0).toBe(0);
    expect(agent.openCounts.get("left")).toBe(1);
    expect(agent.openCounts.get("right") ?? 0).toBe(0);
  });

  it("a stored routing error stays failed until routing-only recovery", async () => {
    let next: unknown = { nextStageIds: ["left", "left"] };
    const invoker = routeInvoker(() => next);
    const setup = await preparedRun(
      "function-route",
      stageKeyedAgent({
        choose: [{ type: "emit", envelope: okEnvelope("choose-ok") }],
        left: [{ type: "emit", envelope: okEnvelope("left-ok") }],
        right: [{ type: "throw", message: "right must not run" }],
      }),
      invoker,
    );
    const failed = await runPipelineDag({
      prepared: setup.prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      functionRouteInvoker: invoker,
    });
    expect(failed.ok).toBe(false);
    expect(setup.prepared.agent.openCounts.get("choose")).toBe(1);
    expect(setup.prepared.agent.openCounts.get("left") ?? 0).toBe(0);
    const scheduler = await import("../src/runtime/pipelineScheduler.js");
    expect(typeof scheduler.recoverFunctionRoute).toBe("function");
    next = { nextStageIds: ["left"] };
    const recovered = await scheduler.recoverFunctionRoute!({
      prepared: setup.prepared,
      stageId: "choose",
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      functionRouteInvoker: invoker,
    });
    expect(recovered.ok).toBe(true);
    expect(setup.prepared.agent.openCounts.get("choose")).toBe(1);
    expect(setup.prepared.agent.openCounts.get("left")).toBe(1);
    expect(setup.prepared.agent.openCounts.get("right") ?? 0).toBe(0);
  });

  it("send-back releases no forward function selection and continue selects forward ids", async () => {
    const seen: Array<string | undefined> = [];
    const { result, prepared, invoker } = await runRouted(
      "route-loop-basic",
      {
        plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
        implement: [
          { type: "emit", envelope: okEnvelope("implement-1") },
          { type: "emit", envelope: okEnvelope("implement-2") },
        ],
        review: [
          {
            type: "emit",
            envelope: okEnvelope("send-back", {
              feedback_loop: { action: "send_back", target: "implement" },
            }),
          },
          {
            type: "emit",
            envelope: okEnvelope("continue", {
              feedback_loop: { action: "continue" },
            }),
          },
        ],
        submit: [{ type: "emit", envelope: okEnvelope("submit-ok") }],
      },
      (call) => {
        seen.push(call.envelope.feedback_loop?.action);
        return { nextStageIds: ["submit"] };
      },
      (loaded) => attachRoute(loaded, "review"),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["continue"]);
    expect(invoker.calls).toHaveLength(1);
    expect(prepared.agent.openCounts.get("submit")).toBe(1);
    expect(prepared.agent.openCounts.get("implement")).toBe(2);
  });

  it("a clone selection runs the minted instances", async () => {
    const { result, prepared } = await runRouted(
      "clone-chain-smallest",
      {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: {
                items: [
                  { id: "a", title: "A" },
                  { id: "b", title: "B" },
                ],
              },
            }),
          },
        ],
        "handle-item~1": [{ type: "emit", envelope: okEnvelope("a", { payload: { id: "a" } }) }],
        "handle-item~2": [{ type: "emit", envelope: okEnvelope("b", { payload: { id: "b" } }) }],
        gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
      },
      () => ({ nextStageIds: ["handle-item"] }),
      (loaded) => attachRoute(loaded, "emit-items"),
    );
    expect(result.ok).toBe(true);
    expect(prepared.agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(prepared.agent.openCounts.get("handle-item~1")).toBe(1);
    expect(prepared.agent.openCounts.get("handle-item~2")).toBe(1);
    expect(prepared.agent.openCounts.get("gather")).toBe(1);
  });

  it("an empty clone selection leaves no clone instances", async () => {
    const { result, prepared, store, run } = await runRouted(
      "clone-chain-smallest",
      {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: { items: [{ id: "a", title: "A" }] },
            }),
          },
        ],
        "handle-item~1": [{ type: "throw", message: "clone must not run" }],
        gather: [{ type: "throw", message: "gather must not run" }],
      },
      () => ({ nextStageIds: [] }),
      (loaded) => attachRoute(loaded, "emit-items"),
    );
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(prepared.agent.openCounts.get("handle-item~1") ?? 0).toBe(0);
    const detail = await store.readRun(run.runId);
    expect(detail.stages.some((stage) => stage.stage_id.includes("~"))).toBe(false);
  });

  it("a function exclusion into a join does not run when another parent skipped", async () => {
    const { result, prepared } = await runRouted(
      "route-if-join",
      {
        kickoff: [
          {
            type: "emit",
            envelope: okEnvelope("kickoff", { fork_choice: ["write"] }),
          },
        ],
        write: [
          {
            type: "emit",
            envelope: okEnvelope("write-ok", { payload: { ready: true } }),
          },
        ],
        draw: [{ type: "throw", message: "draw must not run" }],
        assemble: [{ type: "throw", message: "assemble must not run" }],
      },
      () => ({ nextStageIds: [] }),
      (loaded) => {
        const kickoff = loaded.dag.nodes.find((node) => node.id === "kickoff");
        if (!kickoff) throw new Error("missing kickoff");
        kickoff.fork = { select: "subset", allow_none: true };
        attachRoute(loaded, "write");
      },
    );
    expect(result.ok).toBe(true);
    expect(prepared.agent.openCounts.get("write")).toBe(1);
    expect(prepared.agent.openCounts.get("draw") ?? 0).toBe(0);
    expect(prepared.agent.openCounts.get("assemble") ?? 0).toBe(0);
    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.stages.find((stage) => stage.stage_id === "assemble")?.status).toBe(
      "skipped",
    );
  });
});
