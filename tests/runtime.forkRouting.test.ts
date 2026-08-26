import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import {
  applyForkSkipsFromEnvelopes,
  hydrateScheduleFromStore,
  hydrateScheduleForRetryRoots,
  runPipelineDag,
} from "../src/runtime/pipelineScheduler.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { ResolvedPipelineDag, ResolvedPipelineStageNode } from "../src/types/pipeline.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function okEnvelope(summary: string, extra?: Partial<StageEnvelope>): StageEnvelope {
  return { status: "success", summary, artifacts: [], ...extra };
}

function failEnvelope(summary: string): StageEnvelope {
  return { status: "failure", summary, artifacts: [] };
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

type FakeAgentBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "never_emit" }
  | { type: "throw"; message: string };

function stageKeyedAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
): AgentPort & { openCounts: Map<string, number> } {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  return {
    openCounts,
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      const scripted = scriptedFakeAgent([behavior]);
      return scripted.openStage(input);
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

describe("applyForkSkipsFromEnvelopes", () => {
  it("unchosen child skipped, chosen child untouched", () => {
    const dag = buildDag([
      { id: "clarify", fork: { select: "one", allow_none: false } },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "pending" as const],
    ]);
    const completedEnvelopes = new Map([
      ["clarify", okEnvelope("ok", { fork_choice: ["design-doc"] })],
    ]);

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("design-doc")).toBe("pending");
    expect(states.get("implementation-plan")).toBe("skipped");
  });

  it("cascade: unchosen child pending descendants also skipped", () => {
    const dag = buildDag([
      { id: "clarify", fork: { select: "one", allow_none: false } },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
      { id: "join-doc", needs: "implementation-plan" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "pending" as const],
      ["join-doc", "pending" as const],
    ]);
    const completedEnvelopes = new Map([
      ["clarify", okEnvelope("ok", { fork_choice: ["design-doc"] })],
    ]);

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("design-doc")).toBe("pending");
    expect(states.get("implementation-plan")).toBe("skipped");
    expect(states.get("join-doc")).toBe("skipped");
  });

  it("unchosen child already succeeded: child stays succeeded, pending descendants skipped", () => {
    const dag = buildDag([
      { id: "clarify", fork: { select: "one", allow_none: false } },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
      { id: "join-doc", needs: "implementation-plan" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "succeeded" as const],
      ["join-doc", "pending" as const],
    ]);
    const completedEnvelopes = new Map([
      ["clarify", okEnvelope("ok", { fork_choice: ["design-doc"] })],
    ]);

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("implementation-plan")).toBe("succeeded");
    expect(states.get("join-doc")).toBe("skipped");
  });

  it("fork stage has no envelope: no state change", () => {
    const dag = buildDag([
      { id: "clarify", fork: { select: "one", allow_none: false } },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "pending" as const],
    ]);
    const completedEnvelopes = new Map<string, StageEnvelope>();

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("design-doc")).toBe("pending");
    expect(states.get("implementation-plan")).toBe("pending");
  });

  it("non-fork stage with envelope: no state change", () => {
    const dag = buildDag([
      { id: "clarify" },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "pending" as const],
    ]);
    const completedEnvelopes = new Map([
      ["clarify", okEnvelope("ok", { fork_choice: ["design-doc"] })],
    ]);

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("design-doc")).toBe("pending");
    expect(states.get("implementation-plan")).toBe("pending");
  });

  it("empty fork_choice: all children skipped", () => {
    const dag = buildDag([
      { id: "clarify", fork: { select: "subset", allow_none: true } },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "pending" as const],
    ]);
    const completedEnvelopes = new Map([
      ["clarify", okEnvelope("ok", { fork_choice: [] })],
    ]);

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("design-doc")).toBe("skipped");
    expect(states.get("implementation-plan")).toBe("skipped");
  });

  it("undefined fork_choice treated as empty: all children skipped", () => {
    const dag = buildDag([
      { id: "clarify", fork: { select: "subset", allow_none: false } },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "pending" as const],
    ]);
    const completedEnvelopes = new Map([["clarify", okEnvelope("ok")]]);

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("design-doc")).toBe("skipped");
    expect(states.get("implementation-plan")).toBe("skipped");
  });

  it("idempotent: calling twice produces same result", () => {
    const dag = buildDag([
      { id: "clarify", fork: { select: "one", allow_none: false } },
      { id: "design-doc", needs: "clarify" },
      { id: "implementation-plan", needs: "clarify" },
      { id: "join-doc", needs: "implementation-plan" },
    ]);
    const states = new Map([
      ["clarify", "succeeded" as const],
      ["design-doc", "pending" as const],
      ["implementation-plan", "pending" as const],
      ["join-doc", "pending" as const],
    ]);
    const completedEnvelopes = new Map([
      ["clarify", okEnvelope("ok", { fork_choice: ["design-doc"] })],
    ]);

    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);
    applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);

    expect(states.get("design-doc")).toBe("pending");
    expect(states.get("implementation-plan")).toBe("skipped");
    expect(states.get("join-doc")).toBe("skipped");
  });
});

// ─── Section 2: Integration tests ──────────────────────────────────────────

describe("fork routing integration", () => {
  it("AE1+AE5: exclusive fork — chosen path runs, unchosen and cascade skipped, run succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-ae1-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [
        { type: "emit", envelope: okEnvelope("clarify-ok", { fork_choice: ["design-doc"] }) },
      ],
      "design-doc": [{ type: "emit", envelope: okEnvelope("design-ok") }],
      "implementation-plan": [{ type: "throw", message: "should not be opened" }],
      "join-doc": [{ type: "throw", message: "should not be opened" }],
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
      return meta.status === "succeeded";
    });

    expect(agent.openCounts.get("clarify")).toBe(1);
    expect(agent.openCounts.get("design-doc")).toBe(1);
    expect(agent.openCounts.get("implementation-plan")).toBeUndefined();
    expect(agent.openCounts.get("join-doc")).toBeUndefined();

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
  });

  it("AE2: subset fork — two chosen run, one skipped, run succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-ae2-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [
        {
          type: "emit",
          envelope: okEnvelope("clarify-ok", { fork_choice: ["design-doc", "implementation-plan"] }),
        },
      ],
      "design-doc": [{ type: "emit", envelope: okEnvelope("design-ok") }],
      "implementation-plan": [{ type: "emit", envelope: okEnvelope("impl-ok") }],
      "join-doc": [{ type: "throw", message: "should not be opened" }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("fork-route-subset"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    expect(agent.openCounts.get("design-doc")).toBe(1);
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBeUndefined();

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
  });

  it("AE3: empty choice allowed — all skipped, run succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-ae3-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [
        { type: "emit", envelope: okEnvelope("clarify-ok", { fork_choice: [] }) },
      ],
      "design-doc": [{ type: "throw", message: "should not be opened" }],
      "implementation-plan": [{ type: "throw", message: "should not be opened" }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("fork-route-allow-none"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    expect(agent.openCounts.get("design-doc")).toBeUndefined();
    expect(agent.openCounts.get("implementation-plan")).toBeUndefined();

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
  });

  it("AE8: retry re-decides fork — unchosen successors reset, new choice runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-ae8-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [
        { type: "emit", envelope: failEnvelope("clarify-fail") },
        {
          type: "emit",
          envelope: okEnvelope("clarify-retry", { fork_choice: ["implementation-plan"] }),
        },
      ],
      "design-doc": [{ type: "throw", message: "design-doc should not be opened" }],
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
    expect(agent.openCounts.get("design-doc")).toBeUndefined();
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
  }, 15000);

  it("AE8-success-retry: deciding stage succeeds choosing A, retried choosing B — previously skipped B now runs", async () => {
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
          envelope: okEnvelope("clarify-retry", { fork_choice: ["implementation-plan"] }),
        },
      ],
      "design-doc": [{ type: "throw", message: "design-doc must not run after retry" }],
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
    expect(agent.openCounts.get("design-doc")).toBeUndefined();
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("AE-hydration: fork skips re-applied from stored envelope before first loop tick", async () => {
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
      okEnvelope("clarify-ok", { fork_choice: ["design-doc"] }),
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
      "implementation-plan": [{ type: "throw", message: "implementation-plan must not be opened" }],
      "join-doc": [{ type: "throw", message: "join-doc must not be opened" }],
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
    expect(agent.openCounts.get("implementation-plan")).toBeUndefined();
    expect(agent.openCounts.get("join-doc")).toBeUndefined();
  });
});
