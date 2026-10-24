import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompletedOnlyStageHandle, type StagePort, type StageRunInput } from "../src/agent/port.js";
import { scriptedFakeAgent, type FakeAgentBehavior } from "../src/agent/fakeAgent.js";
import { createStageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { EvalPlan } from "../src/evals/types.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { RunManager } from "../src/runtime/runManager.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

let root: string;
let storeRoot: string;
let store: RunStore;

const okEnvelope = { status: "success" as const, summary: "found one", artifacts: [], payload: { findings: [] } };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-eval-runner-"));
  storeRoot = await mkdtemp(path.join(tmpdir(), "sf-eval-runner-store-"));
  await mkdir(path.join(root, "stages"), { recursive: true });
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await writeFile(path.join(root, ".git"), "");
  store = createRunStore({ rootDir: storeRoot });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(storeRoot, { recursive: true, force: true });
});

function makePlan(over: Partial<EvalPlan> = {}): EvalPlan {
  return {
    evalRunId: "er_1",
    projectRoot: root,
    evalId: "review",
    target: { kind: "stage", file: "stages/review.yaml" },
    targetVersionHash: "h",
    stageModel: "anthropic/claude-haiku-4-5",
    task: { goal: "Review the diff" },
    cases: [
      { id: "c1", position: 0, input: { diff: "d1" }, tags: [] },
      { id: "c2", position: 1, input: { diff: "d2" }, tags: [] },
    ],
    graders: [],
    repeats: 1,
    passThreshold: 0.7,
    concurrency: 2,
    maxCostUsd: 10,
    ...over,
  };
}

function managerFor(agent: StagePort, maxConcurrent = 3, maxQueued?: number): RunManager {
  return new RunManager({
    agent,
    store,
    cwd: root,
    projectRoot: root,
    maxConcurrent,
    ...(maxQueued !== undefined ? { maxQueued } : {}),
  });
}

function runnerFor(manager: RunManager, extra: Record<string, number> = {}) {
  return createStageCaseRunner({ manager, store, pollIntervalMs: 20, ...extra });
}

function usageAgent(costUsd: number, onStart?: (input: StageRunInput) => void): StagePort {
  const run = async () => ({
    ok: true as const,
    envelope: okEnvelope,
    usage: {
      costUsd,
      models: {
        "anthropic/claude-haiku-4-5": {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd,
        },
      },
    },
  });
  return {
    openStage(input) {
      onStart?.(input);
      return createCompletedOnlyStageHandle({ stageId: input.stage.id, run });
    },
    async runStage(input) {
      onStart?.(input);
      return run();
    },
  };
}

function hangingAgent(gate: Promise<void>): StagePort {
  const run = async () => {
    await gate;
    return { ok: false as const, reason: "released" };
  };
  return {
    openStage(input) {
      return createCompletedOnlyStageHandle({ stageId: input.stage.id, run });
    },
    runStage: run,
  };
}

function abortOnCancel(manager: RunManager, release: { resolve(): void }) {
  return {
    startRun: manager.startRun.bind(manager),
    async cancelRun(runId: string, reason: string) {
      const result = await manager.cancelRun(runId, reason);
      release.resolve();
      return result;
    },
  };
}

const req = (caseId = "c1", repeatIndex = 0) => ({ evalRunId: "er_1", caseId, repeatIndex });

describe("stage case runner", () => {
  it("returns the envelope, latency, cost and tokens of a successful stage run", async () => {
    const runner = runnerFor(managerFor(usageAgent(0.02)));
    const result = await runner.runCase(makePlan(), req());
    expect(result).toMatchObject({
      ok: true,
      output: { kind: "envelope", status: "success", summary: "found one", payload: { findings: [] }, artifacts: [] },
      costUsd: 0.02,
      tokensIn: 120,
      tokensOut: 30,
    });
    if (!result.ok) return;
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(runner.spend("er_1")).toBeCloseTo(0.02);
    const detail = await store.readRun(result.stageRunId);
    expect(detail.status).toBe("succeeded");
    expect(detail.pipeline_id).toBe("standalone-review");
  });

  it("marks the run origin eval with no caller and hides it from the default run list", async () => {
    const runner = runnerFor(managerFor(usageAgent(0)));
    const result = await runner.runCase(makePlan(), req());
    if (!result.ok) throw new Error("expected success");
    const meta = await store.readRunMeta(result.stageRunId);
    expect(meta.origin).toBe("eval");
    expect(meta.caller_id).toBeUndefined();
    expect(await store.listRuns({})).toEqual([]);
    expect((await store.listRuns({ origin: "any" })).map((r) => r.run_id)).toEqual([result.stageRunId]);
  });

  it("maps a stage failure to EVAL_STAGE_FAILED with the run id", async () => {
    const runner = runnerFor(managerFor(scriptedFakeAgent([{ type: "throw", message: "boom" }])));
    const result = await runner.runCase(makePlan(), req());
    expect(result).toMatchObject({ ok: false, code: "EVAL_STAGE_FAILED", message: "boom" });
    expect(result.ok ? undefined : result.stageRunId).toBeDefined();
  });

  it("maps an adapter timeout reason to EVAL_STAGE_TIMEOUT", async () => {
    const agent: StagePort = {
      openStage(input) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => ({ ok: false as const, reason: "stage timed out after 500ms" }),
        });
      },
      async runStage() {
        return { ok: false as const, reason: "stage timed out after 500ms" };
      },
    };
    const result = await runnerFor(managerFor(agent)).runCase(makePlan(), req());
    expect(result).toMatchObject({ ok: false, code: "EVAL_STAGE_TIMEOUT" });
  });

  it("cancels a stage that outlives timeout_ms plus the grace and returns EVAL_STAGE_TIMEOUT", async () => {
    await writeFile(
      path.join(root, "stages", "slow.yaml"),
      "id: slow\nsystem_prompt: Slow.\nmodel: anthropic/claude-haiku-4-5\ntimeout_ms: 200\nio:\n  input:\n    schema:\n      type: object\n  output:\n    schema:\n      type: object\n",
    );
    const release = Promise.withResolvers<void>();
    const manager = managerFor(hangingAgent(release.promise));
    const runner = createStageCaseRunner({
      manager: abortOnCancel(manager, release),
      store,
      pollIntervalMs: 20,
      timeoutGraceMs: 0,
    });
    const plan = makePlan({ target: { kind: "stage", file: "stages/slow.yaml" } });
    const result = await runner.runCase(plan, req());
    expect(result).toMatchObject({ ok: false, code: "EVAL_STAGE_TIMEOUT" });
    if (result.ok || result.stageRunId === undefined) throw new Error("expected run id");
    expect((await store.readRun(result.stageRunId)).status).toBe("cancelled");
    release.resolve();
  });

  it("cancels a gate-stopped run and returns EVAL_STAGE_NEEDS_INPUT only once it is terminal", async () => {
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [{ kind: "free_text", id: "p1", message: "Which?" }],
        envelope: okEnvelope,
      } as FakeAgentBehavior,
    ]);
    const manager = managerFor(agent);
    const result = await runnerFor(manager).runCase(makePlan(), req());
    expect(result).toMatchObject({ ok: false, code: "EVAL_STAGE_NEEDS_INPUT" });
    if (result.ok || result.stageRunId === undefined) throw new Error("expected run id");
    expect((await store.readRun(result.stageRunId)).status).toBe("cancelled");
    expect(manager.getActiveCount()).toBe(0);
  });

  it("queues cases behind maxConcurrent 1 and runs them one after the other", async () => {
    let running = 0;
    let peak = 0;
    const agent: StagePort = {
      openStage(input) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, 60));
            running -= 1;
            return { ok: true as const, envelope: okEnvelope };
          },
        });
      },
      async runStage() {
        return { ok: true as const, envelope: okEnvelope };
      },
    };
    const runner = runnerFor(managerFor(agent, 1));
    const plan = makePlan();
    const results = await Promise.all([runner.runCase(plan, req("c1")), runner.runCase(plan, req("c2"))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(1);
  });

  it("retries with backoff when the admission queue is full instead of failing the case", async () => {
    let running = 0;
    let peak = 0;
    const agent: StagePort = {
      openStage(input) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, 60));
            running -= 1;
            return { ok: true as const, envelope: okEnvelope };
          },
        });
      },
      async runStage() {
        return { ok: true as const, envelope: okEnvelope };
      },
    };
    const fast = createStageCaseRunner({
      manager: managerFor(agent, 1, 0),
      store,
      pollIntervalMs: 20,
      busyBackoffMs: { initial: 20, max: 40 },
    });
    const plan = makePlan();
    const results = await Promise.all([fast.runCase(plan, req("c1")), fast.runCase(plan, req("c2"))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(1);
  });

  it("refuses to start once spend reaches the limit, without starting a run", async () => {
    const manager = managerFor(usageAgent(0.6));
    const runner = runnerFor(manager);
    const plan = makePlan({ maxCostUsd: 1 });
    expect((await runner.runCase(plan, req("c1"))).ok).toBe(true);
    expect((await runner.runCase(plan, req("c2"))).ok).toBe(true);
    expect(runner.spend("er_1")).toBeCloseTo(1.2);
    const before = (await store.listRuns({ origin: "any" })).length;
    const refused = await runner.runCase(plan, req("c1", 1));
    expect(refused).toMatchObject({ ok: false, code: "EVAL_BUDGET_EXCEEDED" });
    expect((await store.listRuns({ origin: "any" })).length).toBe(before);
  });

  it("counts judge spend through addSpend", async () => {
    const runner = runnerFor(managerFor(usageAgent(0)));
    runner.addSpend("er_1", 5);
    expect(runner.spend("er_1")).toBe(5);
    const refused = await runner.runCase(makePlan({ maxCostUsd: 5 }), req());
    expect(refused).toMatchObject({ ok: false, code: "EVAL_BUDGET_EXCEEDED" });
  });

  it("cancelAll cancels in-flight stage runs and they end cancelled", async () => {
    const release = Promise.withResolvers<void>();
    const manager = managerFor(hangingAgent(release.promise));
    const runner = createStageCaseRunner({ manager: abortOnCancel(manager, release), store, pollIntervalMs: 20 });
    const plan = makePlan();
    const pending = [runner.runCase(plan, req("c1")), runner.runCase(plan, req("c2"))];
    for (let i = 0; i < 100 && manager.getActiveCount() < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await runner.cancelAll("er_1");
    const results = await Promise.all(pending);
    for (const r of results) {
      expect(r).toMatchObject({ ok: false, code: "EVAL_CANCELLED" });
      if (r.ok || r.stageRunId === undefined) throw new Error("expected run id");
      expect((await store.readRun(r.stageRunId)).status).toBe("cancelled");
    }
    expect((await runner.runCase(plan, req("c1", 1))).ok).toBe(false);
    release.resolve();
  });

  it("puts the plan model override in the stage body, and the materialized model otherwise", async () => {
    const models: Array<string | undefined> = [];
    const agent = usageAgent(0, (input) => models.push(input.stage.model));
    const runner = runnerFor(managerFor(agent));
    await runner.runCase(makePlan(), req("c1"));
    await runner.runCase(makePlan({ modelOverride: "anthropic/claude-sonnet-4-5" }), req("c2"));
    expect(models).toEqual(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5"]);
  });

  it("returns EVAL_ENGINE_ERROR when the case input does not match the stage input schema", async () => {
    const runner = runnerFor(managerFor(usageAgent(0)));
    const plan = makePlan({ cases: [{ id: "bad", position: 0, input: { diff: 5 }, tags: [] }] });
    const result = await runner.runCase(plan, req("bad"));
    expect(result).toMatchObject({ ok: false, code: "EVAL_ENGINE_ERROR" });
    expect(await store.listRuns({ origin: "any" })).toEqual([]);
  });
});
