import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/runstore/createStore.js";
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
