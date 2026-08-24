import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeHitlResumePath,
  scriptedFakeAgent,
} from "../src/agent/fakeAgent.js";
import { appendOperatorPrompt } from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const successEnvelope = {
  status: "success" as const,
  summary: "done",
  artifacts: [] as string[],
};

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

describe("runtime HITL hold/resume (U4)", () => {
  it("AE1: single wait/resume then succeed; next stage does not start during wait", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-"));
    const store = createRunStore({ rootDir: root });
    const opened: string[] = [];
    const base = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
        },
      },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "design-ok",
          artifacts: ["stages/design-doc/attempts/1/artifacts/b.md"],
        },
      },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "plan-ok",
          artifacts: ["stages/implementation-plan/attempts/1/artifacts/c.md"],
        },
      },
    ]);
    const agent = {
      openStage(input: Parameters<typeof base.openStage>[0]) {
        opened.push(input.stage.id);
        return base.openStage(input);
      },
      runStage(input: Parameters<typeof base.runStage>[0]) {
        return base.runStage(input);
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "docs-only",
      task: path.join(fixtures, "tasks", "sample.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      const clarify = detail.stages.find((s) => s.stage_id === "clarify");
      return clarify?.status === "waiting_for_input";
    });

    expect(opened).toEqual(["clarify"]);
    const duringWait = await store.readRun(started.runId);
    expect(duringWait.status).toBe("running");
    const designDoc = duringWait.stages.find((s) => s.stage_id === "design-doc");
    expect(designDoc?.status).toBe("pending");

    const delivered = await manager.deliverAnswer(
      started.runId,
      "clarify",
      "approved",
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });

    expect(opened).toEqual(["clarify", "design-doc", "implementation-plan"]);
    const clarifyEvents = await store.listStageEvents(started.runId, "clarify");
    expect(clarifyEvents.some((e) => e.event === "waiting_for_input")).toBe(
      true,
    );
    expect(clarifyEvents.some((e) => e.event === "resumed")).toBe(true);
    expect(clarifyEvents.some((e) => e.event === "succeeded")).toBe(true);
  });

  it("AE2: multi-wait in one stage; next stage only after envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-"));
    const store = createRunStore({ rootDir: root });
    const opened: string[] = [];
    const base = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["q1", "q2"],
        expectedAnswers: ["a1", "a2"],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
        },
      },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "design-ok",
          artifacts: ["stages/design-doc/attempts/1/artifacts/b.md"],
        },
      },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "plan-ok",
          artifacts: ["stages/implementation-plan/attempts/1/artifacts/c.md"],
        },
      },
    ]);
    const agent = {
      openStage(input: Parameters<typeof base.openStage>[0]) {
        opened.push(input.stage.id);
        return base.openStage(input);
      },
      runStage(input: Parameters<typeof base.runStage>[0]) {
        return base.runStage(input);
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "docs-only",
      task: path.join(fixtures, "tasks", "sample.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status ===
        "waiting_for_input"
      );
    });
    expect(opened).toEqual(["clarify"]);

    await manager.deliverAnswer(started.runId, "clarify", "a1");

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      const clarify = detail.stages.find((s) => s.stage_id === "clarify");
      return (
        clarify?.status === "waiting_for_input" &&
        clarify.events.filter((e) => e.event === "waiting_for_input").length >=
          2
      );
    });
    expect(opened).toEqual(["clarify"]);

    await manager.deliverAnswer(started.runId, "clarify", "a2");

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });
    expect(opened).toEqual(["clarify", "design-doc", "implementation-plan"]);
  });

  it("AE4: answer moves stage to running (resumed), not succeeded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["q1", "q2"],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "single",
      task: path.join(fixtures, "tasks", "sample.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status ===
        "waiting_for_input"
      );
    });

    const delivered = await manager.deliverAnswer(
      started.runId,
      "clarify",
      "first",
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      const clarify = detail.stages.find((s) => s.stage_id === "clarify");
      return (
        clarify?.events.some((e) => e.event === "resumed") === true &&
        clarify.status !== "succeeded"
      );
    });

    const afterFirst = await store.readRun(started.runId);
    const clarify = afterFirst.stages.find((s) => s.stage_id === "clarify")!;
    expect(clarify.status).not.toBe("succeeded");
    expect(clarify.events.some((e) => e.event === "resumed")).toBe(true);
    expect(clarify.status === "running" || clarify.status === "waiting_for_input").toBe(
      true,
    );

    await manager.deliverAnswer(started.runId, "clarify", "second");
    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });
  });

  it("AE3: restart attach keeps waiting; deliverAnswer reconstructs and completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      path.join(fixtures, "tasks", "sample.yaml"),
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml,
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    const resumePath = fakeHitlResumePath(
      buildStageRoots(run.workspaceDir, "clarify"),
      "clarify",
    );
    await writeFile(
      resumePath,
      `${JSON.stringify({
        waitRequests: ["need-input"],
        envelope: successEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const manager2 = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
    });
    const attached = await manager2.attachWaitingStages();
    expect(attached).toEqual([{ runId: run.runId, stageId: "clarify" }]);

    const stillWaiting = await store2.readRun(run.runId);
    expect(
      stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    expect(stillWaiting.status).toBe("running");

    const delivered = await manager2.deliverAnswer(
      run.runId,
      "clarify",
      "after-restart",
    );
    expect(delivered.ok).toBe(true);

    const done = await store2.readRun(run.runId);
    expect(done.status).toBe("succeeded");
    expect(done.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "succeeded",
    );
  });

  it("edge: unknown run/stage → not-found; non-waiting → conflict", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: successEnvelope },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "single",
      task: path.join(fixtures, "tasks", "sample.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });

    const missingRun = await manager.deliverAnswer("no-such-run", "clarify", "x");
    expect(missingRun.ok).toBe(false);
    if (!missingRun.ok) expect(missingRun.status).toBe(404);

    const missingStage = await manager.deliverAnswer(
      started.runId,
      "no-such-stage",
      "x",
    );
    expect(missingStage.ok).toBe(false);
    if (!missingStage.ok) expect(missingStage.status).toBe(404);

    const conflict = await manager.deliverAnswer(started.runId, "clarify", "x");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.status).toBe(409);
  });

  it("error: corrupt resume context fails stage and run (KTD7)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      path.join(fixtures, "tasks", "sample.yaml"),
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml,
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    const resumePath = fakeHitlResumePath(
      buildStageRoots(run.workspaceDir, "clarify"),
      "clarify",
    );
    await writeFile(resumePath, "{not-json", "utf8");
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const manager2 = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
    });
    await manager2.attachWaitingStages();

    const delivered = await manager2.deliverAnswer(
      run.runId,
      "clarify",
      "too-late",
    );
    expect(delivered.ok).toBe(false);

    const detail = await store2.readRun(run.runId);
    expect(detail.status).toBe("failed");
    const clarify = detail.stages.find((s) => s.stage_id === "clarify")!;
    expect(clarify.status).toBe("failed");
    expect(
      clarify.events.some(
        (e) =>
          e.event === "failed" &&
          "reason" in e &&
          String(e.reason).includes("corrupt resume"),
      ),
    ).toBe(true);
  });

  it("AE2: restart mismatch rejects via trail pending (no live park)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-ae2-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      path.join(fixtures, "tasks", "sample.yaml"),
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml,
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });

    const freeTextPrompt: AskOperatorPrompt = {
      kind: "free_text",
      id: "prompt-1",
      message: "What should the module name be?",
    };
    await appendOperatorPrompt(store, run.runId, "clarify", freeTextPrompt);

    const resumePath = fakeHitlResumePath(
      buildStageRoots(run.workspaceDir, "clarify"),
      "clarify",
    );
    await writeFile(
      resumePath,
      `${JSON.stringify({
        waitRequests: [freeTextPrompt],
        envelope: successEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: successEnvelope,
      },
    ]);
    const manager2 = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
    });
    await manager2.attachWaitingStages();
    expect(manager2.getHitlController().hasLiveWait(run.runId, "clarify")).toBe(
      false,
    );

    const rejected = await manager2.deliverAnswer(run.runId, "clarify", {
      promptId: "prompt-1",
      kind: "confirm",
      decision: "accept",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.status).toBe(400);
      expect(rejected.reason).toMatch(/kind/i);
    }

    const stillWaiting = await store2.readRun(run.runId);
    expect(
      stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    const events = await store2.listStageEvents(run.runId, "clarify");
    expect(events.some((e) => e.event === "operator_answer")).toBe(false);
    expect(events.some((e) => e.event === "resumed")).toBe(false);
  });

  it("regression: non-HITL pipeline still succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: successEnvelope },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "single",
      task: path.join(fixtures, "tasks", "sample.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });
  });

  it("AE2: attach then reconcile preserves waiter; deliverAnswer succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-reconcile-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      path.join(fixtures, "tasks", "sample.yaml"),
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml,
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    const resumePath = fakeHitlResumePath(
      buildStageRoots(run.workspaceDir, "clarify"),
      "clarify",
    );
    await writeFile(
      resumePath,
      `${JSON.stringify({
        waitRequests: ["need-input"],
        envelope: successEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });
    await store.updateRunStatus(run.runId, "running");

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const manager2 = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
    });
    const attached = await manager2.attachWaitingStages();
    await manager2.reconcileOrphanedStages();

    expect(attached).toEqual([{ runId: run.runId, stageId: "clarify" }]);

    const stillWaiting = await store2.readRun(run.runId);
    expect(
      stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");

    const delivered = await manager2.deliverAnswer(
      run.runId,
      "clarify",
      "after-attach-reconcile",
    );
    expect(delivered.ok).toBe(true);

    const done = await store2.readRun(run.runId);
    expect(done.status).toBe("succeeded");
    expect(done.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "succeeded",
    );
  });

  it("parallel waiter + reconciled orphan sibling: deliverAnswer completes waiter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-par-reconcile-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      path.join(fixtures, "tasks", "sample.yaml"),
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "parallel-hitl-fork",
      taskYaml,
      taskId: "sample",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", successEnvelope);

    await store.ensureStageWorkspace(run.runId, "design-doc");
    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    const designResumePath = fakeHitlResumePath(
      buildStageRoots(run.workspaceDir, "design-doc"),
      "design-doc",
    );
    await writeFile(
      designResumePath,
      `${JSON.stringify({
        waitRequests: ["need-input"],
        envelope: successEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "design-doc", {
      event: "waiting_for_input",
    });

    await store.appendStageEvent(run.runId, "implementation-plan", {
      event: "started",
    });
    await store.updateRunStatus(run.runId, "running");

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const manager2 = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
    });
    const attached = await manager2.attachWaitingStages();
    const reconciled = await manager2.reconcileOrphanedStages();

    expect(attached).toEqual([{ runId: run.runId, stageId: "design-doc" }]);
    expect(reconciled.reconciled).toEqual([
      {
        runId: run.runId,
        stageId: "implementation-plan",
        reason: "process_interrupted: no active worker (server restart)",
      },
    ]);

    const mid = await store2.readRun(run.runId);
    expect(
      mid.stages.find((s) => s.stage_id === "design-doc")?.status,
    ).toBe("waiting_for_input");
    expect(
      mid.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("failed");

    const delivered = await manager2.deliverAnswer(
      run.runId,
      "design-doc",
      "approved",
    );
    if (!delivered.ok) {
      expect(delivered.status).not.toBe(409);
    }

    await waitFor(async () => {
      const detail = await store2.readRun(run.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "succeeded"
      );
    });

    const done = await store2.readRun(run.runId);
    expect(done.stages.find((s) => s.stage_id === "design-doc")?.status).toBe(
      "succeeded",
    );
    expect(
      done.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("failed");
    expect(done.status).toBe("failed");
  });
});
