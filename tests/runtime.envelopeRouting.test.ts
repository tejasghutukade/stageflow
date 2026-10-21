import { describe, expect, it } from "vitest";
import { pipelinePath, catalogLocators, LINEAR_EXPLICIT_PIPELINE } from "./helpers/fixturePaths.js";
import { access, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { formatPriorEnvelope } from "../src/prompt/priorEnvelope.js";
import {
  buildCompletedEnvelopesFromRun,
  buildStageConfigById,
  resolvePriorEnvelope,
} from "../src/runtime/envelopeRouting.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import {
  attemptEnvelopePath,
  envelopePath,
} from "../src/runstore/workspaceLayout.js";
import {
  DEFAULT_MAX_ACTIVE_STAGES_PER_RUN,
  readMaxActiveStagesPerRun,
} from "../src/runtime/stageConcurrency.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

describe("readMaxActiveStagesPerRun (U1)", () => {
  const ENV = "STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN";

  it("defaults to unlimited when env unset", () => {
    expect(readMaxActiveStagesPerRun({})).toBe(DEFAULT_MAX_ACTIVE_STAGES_PER_RUN);
    expect(Number.isFinite(readMaxActiveStagesPerRun({}))).toBe(false);
  });

  it.each([
    { name: "valid env value", env: { [ENV]: "5" }, override: undefined, expected: 5 },
    { name: "zero falls back to unlimited", env: { [ENV]: "0" }, override: undefined, expected: DEFAULT_MAX_ACTIVE_STAGES_PER_RUN },
    { name: "non-numeric falls back to unlimited", env: { [ENV]: "abc" }, override: undefined, expected: DEFAULT_MAX_ACTIVE_STAGES_PER_RUN },
    { name: "constructor override wins over env", env: { [ENV]: "5" }, override: 2, expected: 2 },
  ])("$name", ({ env, override, expected }) => {
    expect(readMaxActiveStagesPerRun(env, override)).toBe(expected);
  });
});

describe("resolvePriorEnvelope (U2)", () => {
  async function loadDag(pipelineId: string) {
    return loadPipeline(pipelinePath(pipelineId), { cwd: fixtures });
  }

  it("root stage receives null prior", async () => {
    const loaded = await loadDag("parallel-after-clarify");
    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "clarify",
      completedEnvelopes: new Map(),
    });
    expect(result).toEqual({ ok: true, prior: null });
  });

  it("linear child receives parent envelope", async () => {
    const loaded = await loadDag("linear-explicit");
    const parent: StageEnvelope = {
      status: "success",
      summary: "from-a",
      artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
    };
    const completed = new Map<string, StageEnvelope>([["clarify", parent]]);
    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "design-doc",
      completedEnvelopes: completed,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prior?.summary).toBe("from-a");
    expect(result.joinPriors).toBeUndefined();
    expect(result.priorEnvelopesByStage).toBeUndefined();
  });

  it("fork siblings each get independent copies", async () => {
    const loaded = await loadDag("parallel-after-clarify");
    const parent: StageEnvelope = {
      status: "success",
      summary: "ancestor",
      artifacts: [],
      payload: { tag: "shared" },
    };
    const completed = new Map<string, StageEnvelope>([["clarify", parent]]);

    const b = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "design-doc",
      completedEnvelopes: completed,
    });
    const c = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "implementation-plan",
      completedEnvelopes: completed,
    });
    expect(b.ok && c.ok).toBe(true);
    if (!b.ok || !c.ok) return;

    b.prior!.payload!.tag = "mutated-b";
    expect(c.prior?.payload?.tag).toBe("shared");
    expect(parent.payload?.tag).toBe("shared");
  });

  it("missing predecessor envelope fails with clear reason", async () => {
    const loaded = await loadDag("parallel-after-clarify");
    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "design-doc",
      completedEnvelopes: new Map(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("clarify");
  });

  it("buildStageConfigById indexes loaded stages", async () => {
    const loaded = await loadDag("docs-only");
    const byId = buildStageConfigById(loaded);
    expect(byId.get("clarify")?.id).toBe("clarify");
    expect(byId.size).toBe(loaded.stages.length);
  });
});

const storeKinds = ["sqlite"] as const;

async function seedAttempt2EnvelopeOnDiskOnly(
  store: RunStore,
  runId: string,
  stageId: string,
  envelope: StageEnvelope,
) {
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt: 1 });
  await store.appendStageEvent(
    runId,
    stageId,
    { event: "failed", reason: "fail" },
    { attempt: 1 },
  );
  await store.updateStageExecution(runId, stageId, 1, {
    status: "failed",
    envelope: { status: "failure", summary: "fail", artifacts: [] },
  });

  await store.createStageExecution(runId, stageId);
  await store.ensureAttemptWorkspace(runId, stageId, 2);
  await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt: 2 });
  await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt: 2 });
  await store.writeEnvelope(runId, stageId, envelope, { attempt: 2 });
  await store.updateStageExecution(runId, stageId, 2, {
    status: "succeeded",
    envelope: null,
  });

  const workspaceDir = store.getWorkspaceDir(runId);
  try {
    await unlink(envelopePath(workspaceDir, stageId));
  } catch {
    // no legacy root envelope
  }
}

describe.each(storeKinds)("buildCompletedEnvelopesFromRun (%s)", (kind) => {
  it("includes upstream succeeded on attempt 2 without root envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-env-route-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      ...catalogLocators("linear-explicit"),
      taskYaml: "id: t\ngoal: g\n",
    });

    const upstreamEnvelope: StageEnvelope = {
      status: "success",
      summary: "upstream-attempt-2",
      artifacts: [],
    };
    await seedAttempt2EnvelopeOnDiskOnly(
      store,
      run.runId,
      "clarify",
      upstreamEnvelope,
    );
    await store.updateRunStatus(run.runId, "failed");

    const detail = await store.readRun(run.runId);
    const completed = await buildCompletedEnvelopesFromRun(
      store,
      run.runId,
      detail.stages,
    );

    expect(completed.get("clarify")).toEqual(upstreamEnvelope);
  });

  it("resolvePriorEnvelope reads upstream attempt-2 envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-env-prior-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      ...catalogLocators("linear-explicit"),
      taskYaml: "id: t\ngoal: g\n",
    });

    const upstreamEnvelope: StageEnvelope = {
      status: "success",
      summary: "upstream-attempt-2",
      artifacts: [],
    };
    await seedAttempt2EnvelopeOnDiskOnly(
      store,
      run.runId,
      "clarify",
      upstreamEnvelope,
    );

    const workspaceDir = store.getWorkspaceDir(run.runId);
    await expect(
      access(envelopePath(workspaceDir, "clarify")),
    ).rejects.toThrow();
    await expect(
      access(attemptEnvelopePath(workspaceDir, "clarify", 2)),
    ).rejects.toThrow();
    await expect(store.readEnvelope(run.runId, "clarify")).resolves.toEqual(
      upstreamEnvelope,
    );

    const loaded = await loadPipeline(LINEAR_EXPLICIT_PIPELINE, { cwd: fixtures });
    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "design-doc",
      completedEnvelopes: new Map(),
      store,
      runId: run.runId,
    });

    expect(result).toEqual({ ok: true, prior: upstreamEnvelope });
  });
});



function okEnvelope(summary: string): StageEnvelope {
  return { status: "success", summary, artifacts: [], payload: {} };
}

async function seedStageTerminal(
  store: RunStore,
  runId: string,
  stageId: string,
  status: "succeeded" | "failed" | "skipped",
  options?: { envelope?: StageEnvelope; reason?: string },
) {
  await store.ensureStageWorkspace(runId, stageId);
  if (status === "skipped") {
    if (options?.envelope) {
      await store.createStageExecution(runId, stageId);
      await store.writeEnvelope(runId, stageId, options.envelope);
    }
    await store.appendStageEvent(runId, stageId, { event: "skipped" });
    return;
  }
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" });
  if (status === "succeeded") {
    await store.appendStageEvent(runId, stageId, { event: "succeeded" });
    if (options?.envelope) {
      await store.writeEnvelope(runId, stageId, options.envelope);
      await store.updateStageExecution(runId, stageId, 1, {
        status: "succeeded",
        envelope: options.envelope,
      });
    }
    return;
  }
  await store.appendStageEvent(runId, stageId, {
    event: "failed",
    reason: options?.reason ?? "stage failed",
  });
  await store.updateStageExecution(runId, stageId, 1, {
    status: "failed",
    envelope: options?.envelope ?? null,
  });
  if (options?.envelope) {
    await store.writeEnvelope(runId, stageId, options.envelope);
  }
}

describe("resolvePriorEnvelope generic fan-in (U2)", () => {
  it("diamond synthesize gets keyed priors in declaration order", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
      cwd: fixtures,
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-env-diamond-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("diamond-fan-in"),
      taskYaml: "id: t\ngoal: g\n",
    });
    const research = okEnvelope("from-research");
    const validation = okEnvelope("from-validation");
    await seedStageTerminal(store, run.runId, "validation", "succeeded", {
      envelope: validation,
    });
    await seedStageTerminal(store, run.runId, "research", "succeeded", {
      envelope: research,
    });

    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "synthesize",
      completedEnvelopes: new Map(),
      store,
      runId: run.runId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prior).toBeNull();
    expect(result.joinPriors).toBeUndefined();
    expect(Object.keys(result.priorEnvelopesByStage ?? {})).toEqual([
      "research",
      "validation",
    ]);
    expect(result.priorEnvelopesByStage?.research).toEqual(research);
    expect(result.priorEnvelopesByStage?.validation).toEqual(validation);
  });

  it("diamond synthesize keys priors in reversed YAML declaration order", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in-reversed"), {
      cwd: fixtures,
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-env-diamond-rev-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("diamond-fan-in-reversed"),
      taskYaml: "id: t\ngoal: g\n",
    });
    const research = okEnvelope("from-research");
    const validation = okEnvelope("from-validation");
    await seedStageTerminal(store, run.runId, "research", "succeeded", {
      envelope: research,
    });
    await seedStageTerminal(store, run.runId, "validation", "succeeded", {
      envelope: validation,
    });

    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "synthesize",
      completedEnvelopes: new Map(),
      store,
      runId: run.runId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prior).toBeNull();
    expect(result.joinPriors).toBeUndefined();
    expect(Object.keys(result.priorEnvelopesByStage ?? {})).toEqual([
      "validation",
      "research",
    ]);
    expect(result.priorEnvelopesByStage?.validation).toEqual(validation);
    expect(result.priorEnvelopesByStage?.research).toEqual(research);
  });

  it.each([
    {
      name: "failed parent with emitted failure envelope",
      state: "failed" as const,
      seed: { envelope: { status: "failure", summary: "emitted-fail", artifacts: [] } as StageEnvelope, reason: "persisted-reason" },
      completed: undefined,
    },
    {
      name: "failed parent without envelope",
      state: "failed" as const,
      seed: { reason: "validation crashed" },
      completed: undefined,
    },
    {
      name: "skipped parent with envelope on disk and in memory",
      state: "skipped" as const,
      seed: { envelope: okEnvelope("should-not-win") },
      completed: okEnvelope("should-not-win"),
    },
    {
      name: "failed parent's stale emitted success envelope",
      state: "failed" as const,
      seed: { envelope: okEnvelope("stale-success"), reason: "agent crashed" },
      completed: okEnvelope("stale-success"),
    },
  ])("$name is omitted from priorEnvelopesByStage", async ({ state, seed, completed }) => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
      cwd: fixtures,
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-env-omit-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("diamond-fan-in"),
      taskYaml: "id: t\ngoal: g\n",
    });
    await seedStageTerminal(store, run.runId, "research", state, seed);
    await seedStageTerminal(store, run.runId, "validation", "succeeded", {
      envelope: okEnvelope("from-validation"),
    });

    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "synthesize",
      completedEnvelopes: completed ? new Map([["research", completed]]) : new Map(),
      store,
      runId: run.runId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.priorEnvelopesByStage ?? {})).toEqual(["validation"]);
    expect(result.priorEnvelopesByStage?.validation).toEqual(
      okEnvelope("from-validation"),
    );
  });

  it("formatPriorEnvelope renders keyed aggregate in declaration order", () => {
    const text = formatPriorEnvelope(null, undefined, {
      research: okEnvelope("from-research"),
      validation: okEnvelope("from-validation"),
    });
    expect(text).toContain("Prior envelopes by stage (declaration order):");
    expect(text.indexOf('"research"')).toBeLessThan(text.indexOf('"validation"'));
    expect(text).toContain('"summary": "from-research"');
    expect(text).toContain('"summary": "from-validation"');
    expect(text).not.toContain("clones, clone-list order");
    expect(text).not.toContain("No prior envelope (first stage).");
  });
});
