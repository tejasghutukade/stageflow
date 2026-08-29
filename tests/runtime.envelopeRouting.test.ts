import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, catalogLocators, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
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
  it("defaults to unlimited when env unset", () => {
    expect(readMaxActiveStagesPerRun({})).toBe(DEFAULT_MAX_ACTIVE_STAGES_PER_RUN);
    expect(Number.isFinite(readMaxActiveStagesPerRun({}))).toBe(false);
  });

  it("reads valid env value", () => {
    expect(
      readMaxActiveStagesPerRun({
        STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN: "5",
      }),
    ).toBe(5);
  });

  it("falls back to unlimited for invalid env", () => {
    expect(
      readMaxActiveStagesPerRun({
        STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN: "0",
      }),
    ).toBe(DEFAULT_MAX_ACTIVE_STAGES_PER_RUN);
    expect(
      readMaxActiveStagesPerRun({
        STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN: "abc",
      }),
    ).toBe(DEFAULT_MAX_ACTIVE_STAGES_PER_RUN);
  });

  it("constructor override wins over env", () => {
    expect(
      readMaxActiveStagesPerRun(
        { STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN: "5" },
        2,
      ),
    ).toBe(2);
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

describe("resolvePriorEnvelope clone join list (U2 / U5)", () => {
  it("once successor prior is the item envelope, not the predecessor", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const parent: StageEnvelope = {
      status: "success",
      summary: "clarify-summary",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "design-doc",
          action: "once",
          envelope: {
            status: "success",
            summary: "once-prior",
            artifacts: [],
          },
        },
      ],
    };
    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "design-doc",
      completedEnvelopes: new Map([["clarify", parent]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prior?.summary).toBe("once-prior");
    expect(result.joinPriors).toBeUndefined();
  });

  it("join of three clones fills joinPriors in clone-list order", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 3,
    });
    const completed = new Map<string, StageEnvelope>([
      ["design-doc~1", { status: "success", summary: "a", artifacts: [] }],
      ["design-doc~2", { status: "failure", summary: "b-fail", artifacts: [] }],
      ["design-doc~3", { status: "success", summary: "c", artifacts: [] }],
    ]);
    const result = await resolvePriorEnvelope({
      dag: snapshot,
      stageId: "join-doc",
      completedEnvelopes: completed,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prior).toBeNull();
    expect(result.joinPriors?.map((e) => e.summary)).toEqual([
      "a",
      "b-fail",
      "c",
    ]);
  });

  it("missing succeeded-clone envelope fails closed", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 2,
    });
    const result = await resolvePriorEnvelope({
      dag: snapshot,
      stageId: "join-doc",
      completedEnvelopes: new Map([
        ["design-doc~1", { status: "success", summary: "a", artifacts: [] }],
      ]),
    });
    expect(result.ok).toBe(false);
  });

  it("root stage still has prior null and no joinPriors", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const result = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "clarify",
      completedEnvelopes: new Map(),
    });
    expect(result).toEqual({ ok: true, prior: null });
  });

  it("formatPriorEnvelope renders clone-list JSON when joinPriors present", () => {
    const text = formatPriorEnvelope(null, [
      { status: "success", summary: "a", artifacts: [] },
      { status: "failure", summary: "b", artifacts: [] },
    ]);
    expect(text).toContain("Prior envelopes (2 clones, clone-list order):");
    expect(text).toContain('"summary": "a"');
    expect(text).toContain('"summary": "b"');
  });
});
