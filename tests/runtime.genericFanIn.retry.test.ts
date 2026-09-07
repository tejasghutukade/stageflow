import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { RunManager } from "../src/runtime/runManager.js";
import { retryRun } from "../src/runtime/pipelineScheduler.js";
import { loadRunContext } from "../src/runtime/resumeReconstruct.js";
import { syncRunStatusFromStages } from "../src/runtime/stageRecovery.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import type { StageEnvelope, TerminalEnvelope } from "../src/types/envelope.js";
import type { CloneForkItem } from "../src/types/forkChoice.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";
import { seedDiamondRun } from "./helpers/seedDiamondRun.js";

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
      | { type: "fail"; reason: string; envelope?: StageEnvelope }
    >
  >;
}): AgentPort & {
  openCounts: Map<string, number>;
  priorByStage: Map<
    string,
    Array<Record<string, TerminalEnvelope | TerminalEnvelope[]> | undefined>
  >;
} {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const priorByStage = new Map<
    string,
    Array<Record<string, TerminalEnvelope | TerminalEnvelope[]> | undefined>
  >();

  const agent: AgentPort & {
    openCounts: Map<string, number>;
    priorByStage: Map<
      string,
      Array<Record<string, TerminalEnvelope | TerminalEnvelope[]> | undefined>
    >;
  } = {
    openCounts,
    priorByStage,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const priors = priorByStage.get(stageId) ?? [];
      priors.push(input.priorEnvelopesByStage);
      priorByStage.set(stageId, priors);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = options.behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? {
        type: "emit" as const,
        envelope: okEnvelope(`${stageId}-fallback`),
      };
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

async function seedAcceptedFailurePendingJoin(
  store: RunStore,
): Promise<{ runId: string }> {
  const { runId } = await seedDiamondRun(
    store,
    "diamond-fan-in-accepted",
    {
      clarify: "succeeded",
      research: "failed",
      validation: "succeeded",
      synthesize: "pending",
    },
    "running",
  );
  await store.writeEnvelope(
    runId,
    "clarify",
    okEnvelope("clarify-ok", { fork_choice: ["research", "validation"] }),
  );
  await store.writeEnvelope(runId, "research", {
    status: "failure",
    summary: "research boom",
    artifacts: [],
  });
  await store.writeEnvelope(runId, "validation", okEnvelope("validation-ok"));
  return { runId };
}

async function retryAncestorDirect(
  store: RunStore,
  agent: AgentPort,
  runId: string,
  stageId: string,
): Promise<void> {
  const execution = await store.createStageExecution(runId, stageId);
  const { meta, task, loaded, workspaceDir } = await loadRunContext(
    store,
    runId,
    fixtures,
  );
  await retryRun({
    prepared: {
      task,
      loaded,
      run: { runId, workspaceDir },
      agent,
      store,
      cwd: fixtures,
      checkoutRoot: meta.checkout_root,
    },
    retryRoots: new Map([[stageId, execution.attempt]]),
    maxActiveStagesPerRun: 4,
    executionMode: "inprocess",
  });
  await syncRunStatusFromStages(store, runId);
}

describe("generic fan-in retry invalidation", () => {
  it("retry research reruns synthesize with new research + preserved validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-retry-research-"));
    const store = createRunStore({ rootDir: root });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [{ type: "emit", envelope: okEnvelope("clarify-ok") }],
        research: [
          { type: "emit", envelope: okEnvelope("research-first") },
          { type: "emit", envelope: okEnvelope("research-retry") },
        ],
        validation: [{ type: "emit", envelope: okEnvelope("validation-kept") }],
        synthesize: [
          { type: "emit", envelope: okEnvelope("syn-first") },
          { type: "emit", envelope: okEnvelope("syn-retry") },
        ],
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

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    const retry = await manager.retryStage(started.runId, "research");
    expect(retry.ok).toBe(true);

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    expect(agent.openCounts.get("research")).toBe(2);
    expect(agent.openCounts.get("validation")).toBe(1);
    expect(agent.openCounts.get("synthesize")).toBe(2);
    expect(agent.openCounts.get("clarify")).toBe(1);

    const synPriors = agent.priorByStage.get("synthesize") ?? [];
    expect(synPriors).toHaveLength(2);
    const retryPrior = synPriors[1];
    expect(Object.keys(retryPrior ?? {})).toEqual(["research", "validation"]);
    expect(retryPrior?.research).toEqual(okEnvelope("research-retry"));
    expect(retryPrior?.validation).toEqual(okEnvelope("validation-kept"));
    expect(retryPrior?.["research~1"]).toBeUndefined();

    const detail = await store.readRun(started.runId);
    expect(detail.stages.find((s) => s.stage_id === "validation")?.attempt_count).toBe(1);
    expect(detail.stages.find((s) => s.stage_id === "research")?.attempt_count).toBe(2);
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.attempt_count).toBe(2);
  }, 15000);

  it("retry validation reruns synthesize with preserved research + new validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-retry-validation-"));
    const store = createRunStore({ rootDir: root });
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [{ type: "emit", envelope: okEnvelope("clarify-ok") }],
        research: [{ type: "emit", envelope: okEnvelope("research-kept") }],
        validation: [
          { type: "emit", envelope: okEnvelope("validation-first") },
          { type: "emit", envelope: okEnvelope("validation-retry") },
        ],
        synthesize: [
          { type: "emit", envelope: okEnvelope("syn-first") },
          { type: "emit", envelope: okEnvelope("syn-retry") },
        ],
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

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    const retry = await manager.retryStage(started.runId, "validation");
    expect(retry.ok).toBe(true);

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    expect(agent.openCounts.get("research")).toBe(1);
    expect(agent.openCounts.get("validation")).toBe(2);
    expect(agent.openCounts.get("synthesize")).toBe(2);

    const retryPrior = (agent.priorByStage.get("synthesize") ?? [])[1];
    expect(retryPrior?.research).toEqual(okEnvelope("research-kept"));
    expect(retryPrior?.validation).toEqual(okEnvelope("validation-retry"));
  }, 15000);

  it("accepted-fork diamond: retry research does not remint the sibling fork branch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-retry-fork-"));
    const store = createRunStore({ rootDir: root });
    const forkChoice = ["research", "validation"] as const;
    const agent = gatedFanInAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              fork_choice: [...forkChoice],
            }),
          },
        ],
        research: [
          { type: "emit", envelope: okEnvelope("research-first") },
          { type: "emit", envelope: okEnvelope("research-retry") },
        ],
        validation: [{ type: "emit", envelope: okEnvelope("validation-kept") }],
        synthesize: [
          { type: "emit", envelope: okEnvelope("syn-first") },
          { type: "emit", envelope: okEnvelope("syn-retry") },
        ],
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
      pipeline: pipelinePath("diamond-fan-in-accepted"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    const before = await store.readRun(started.runId);
    const clarifyBefore = before.stages.find((s) => s.stage_id === "clarify");
    expect(clarifyBefore?.envelope?.fork_choice).toEqual([...forkChoice]);

    const retry = await manager.retryStage(started.runId, "research");
    expect(retry.ok).toBe(true);

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    expect(agent.openCounts.get("clarify")).toBe(1);
    expect(agent.openCounts.get("validation")).toBe(1);
    expect(agent.openCounts.get("research")).toBe(2);
    expect(agent.openCounts.get("synthesize")).toBe(2);

    const after = await store.readRun(started.runId);
    const clarifyAfter = after.stages.find((s) => s.stage_id === "clarify");
    expect(clarifyAfter?.envelope?.fork_choice).toEqual([...forkChoice]);
    expect(clarifyAfter?.attempt_count).toBe(1);
    expect(after.stages.find((s) => s.stage_id === "validation")?.attempt_count).toBe(1);
  }, 15000);

  it("retry one research clone instance resets synthesize, not the sibling clone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-retry-clone-"));
    const store = createRunStore({ rootDir: root });
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
          { type: "emit", envelope: okEnvelope("r1-first") },
          { type: "emit", envelope: okEnvelope("r1-retry") },
        ],
        "research~2": [{ type: "emit", envelope: okEnvelope("r2-kept") }],
        validation: [{ type: "emit", envelope: okEnvelope("validation-kept") }],
        synthesize: [
          { type: "emit", envelope: okEnvelope("syn-first") },
          { type: "emit", envelope: okEnvelope("syn-retry") },
        ],
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

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    const beforeDag = (await store.readRunMeta(started.runId)).pipeline_dag;
    expect(beforeDag?.stage_ids).toEqual(
      expect.arrayContaining(["research~1", "research~2"]),
    );
    expect(beforeDag?.stage_ids).not.toContain("research~3");

    await retryAncestorDirect(store, agent, started.runId, "research~1");

    expect((await store.readRunMeta(started.runId)).status).toBe("succeeded");
    expect(agent.openCounts.get("research~1")).toBe(2);
    expect(agent.openCounts.get("research~2")).toBe(1);
    expect(agent.openCounts.get("validation")).toBe(1);
    expect(agent.openCounts.get("clarify")).toBe(1);
    expect(agent.openCounts.get("synthesize")).toBe(2);

    const retryPrior = (agent.priorByStage.get("synthesize") ?? [])[1];
    expect(Object.keys(retryPrior ?? {})).toEqual(["research", "validation"]);
    expect(
      Array.isArray(retryPrior?.research)
        ? retryPrior.research.map((e) => e.summary)
        : undefined,
    ).toEqual(["r1-retry", "r2-kept"]);
    expect(retryPrior?.validation).toEqual(okEnvelope("validation-kept"));
    expect(retryPrior?.["research~1"]).toBeUndefined();
    expect(retryPrior?.["research~2"]).toBeUndefined();

    const afterDag = (await store.readRunMeta(started.runId)).pipeline_dag;
    expect(afterDag?.stage_ids).not.toContain("research~3");
    expect(afterDag?.stage_ids?.filter((id) => id.startsWith("research~"))).toEqual(
      ["research~1", "research~2"],
    );
  }, 15000);

  it("retry of an accepted-failed parent that fails again still runs the join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-retry-refail-"));
    const store = createRunStore({ rootDir: root });
    const failEnvelope = (summary: string): StageEnvelope => ({
      status: "failure",
      summary,
      artifacts: [],
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
        research: [
          { type: "fail", reason: "research boom", envelope: failEnvelope("research-first-fail") },
          { type: "fail", reason: "research boom again", envelope: failEnvelope("research-retry-fail") },
        ],
        validation: [{ type: "emit", envelope: okEnvelope("validation-kept") }],
        synthesize: [
          { type: "emit", envelope: okEnvelope("syn-first") },
          { type: "emit", envelope: okEnvelope("syn-retry") },
        ],
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
      pipeline: pipelinePath("diamond-fan-in-accepted"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");
    expect(agent.openCounts.get("synthesize")).toBe(1);

    const retry = await manager.retryStage(started.runId, "research");
    expect(retry.ok).toBe(true);

    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    expect(agent.openCounts.get("research")).toBe(2);
    expect(agent.openCounts.get("validation")).toBe(1);
    expect(agent.openCounts.get("synthesize")).toBe(2);

    const retryPrior = (agent.priorByStage.get("synthesize") ?? [])[1];
    expect(Object.keys(retryPrior ?? {})).toEqual(["research", "validation"]);
    expect(retryPrior?.research).toEqual(failEnvelope("research-retry-fail"));
    expect(retryPrior?.validation).toEqual(okEnvelope("validation-kept"));

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("succeeded");
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe("failed");
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.status).toBe("succeeded");
  }, 15000);

  it("retries an accepted-failed parent while the accepting join is still pending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-retry-pending-join-"));
    const store = createRunStore({ rootDir: root });
    let releaseSynthesize!: () => void;
    const holdSynthesize = new Promise<void>((resolve) => {
      releaseSynthesize = resolve;
    });
    let holdingSynthesize = false;
    const originalCreate = store.createStageExecution.bind(store);
    store.createStageExecution = async (runId, stageId) => {
      if (stageId === "synthesize" && !holdingSynthesize) {
        holdingSynthesize = true;
        await holdSynthesize;
      }
      return originalCreate(runId, stageId);
    };

    const failEnvelope = (summary: string): StageEnvelope => ({
      status: "failure",
      summary,
      artifacts: [],
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
        research: [
          { type: "fail", reason: "research boom", envelope: failEnvelope("research-fail") },
          { type: "emit", envelope: okEnvelope("research-retry") },
        ],
        validation: [{ type: "emit", envelope: okEnvelope("validation-ok") }],
        synthesize: [{ type: "emit", envelope: okEnvelope("syn-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("diamond-fan-in-accepted"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      const research = detail.stages.find((s) => s.stage_id === "research");
      const validation = detail.stages.find((s) => s.stage_id === "validation");
      const synthesize = detail.stages.find((s) => s.stage_id === "synthesize");
      return (
        research?.status === "failed" &&
        validation?.status === "succeeded" &&
        synthesize?.status === "pending" &&
        holdingSynthesize
      );
    });

    expect(manager.getActiveRunIds()).toContain(started.runId);

    try {
      const retry = await manager.retryStage(started.runId, "research");
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(agent.openCounts.get("research")).toBe(2);
      const mid = await store.readRun(started.runId);
      expect(mid.stages.find((s) => s.stage_id === "synthesize")?.status).not.toBe(
        "succeeded",
      );
    } finally {
      releaseSynthesize();
    }
  }, 15000);

  it("retries when projected status is running but persisted meta is failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-retry-meta-"));
    const store = createRunStore({ rootDir: root });
    const { runId } = await seedDiamondRun(
      store,
      "diamond-fan-in-accepted",
      {
        clarify: "succeeded",
        research: "failed",
        validation: "succeeded",
        synthesize: "pending",
      },
      "failed",
    );

    const detail = await store.readRun(runId);
    const meta = await store.readRunMeta(runId);
    expect(detail.status).toBe("running");
    expect(meta.status).toBe("failed");

    const agent = gatedFanInAgent({
      behaviorsByStage: {
        research: [{ type: "emit", envelope: okEnvelope("research-retry") }],
        synthesize: [{ type: "emit", envelope: okEnvelope("syn-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    const result = await manager.retryStage(runId, "research");
    expect(result.ok).toBe(true);
  }, 15000);

  it("host restart resumes a pending join behind an accepted failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-diamond-restart-join-"));
    const store = createRunStore({ rootDir: root });
    const { runId } = await seedAcceptedFailurePendingJoin(store);

    const agent = gatedFanInAgent({
      behaviorsByStage: {
        synthesize: [{ type: "emit", envelope: okEnvelope("syn-restart") }],
      },
    });
    const boot = await bootstrapStageflowHost({
      agent,
      cwd: fixtures,
      rootDir: root,
      store,
    });

    await waitFor(async () => (await store.readRunMeta(runId)).status === "succeeded");

    expect(agent.openCounts.get("synthesize")).toBe(1);
    expect(agent.openCounts.get("research")).toBeUndefined();
    const detail = await store.readRun(runId);
    expect(detail.status).toBe("succeeded");
    expect(detail.stages.find((s) => s.stage_id === "research")?.status).toBe(
      "failed",
    );
    expect(detail.stages.find((s) => s.stage_id === "synthesize")?.status).toBe(
      "succeeded",
    );
    expect(boot.manager.getActiveRunIds()).not.toContain(runId);
  }, 15000);
});
