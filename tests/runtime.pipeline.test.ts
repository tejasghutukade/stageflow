import { describe, expect, it, vi } from "vitest";
import { pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, LINEAR_EXPLICIT_PIPELINE } from "./helpers/fixturePaths.js";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { runPipeline } from "../src/runtime/pipelineRunner.js";
import { RunManager } from "../src/runtime/runManager.js";
import { runStage } from "../src/runtime/stageRunner.js";
import { createRunStore } from "../src/runstore/createStore.js";

const permsEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("stage and pipeline runners", () => {
  it("stage success writes envelope and returns artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "clarified",
          artifacts: ["stages/clarify/attempts/1/artifacts/notes.md"],
        },
      },
    ]);

    const result = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
    });

    expect(result.ok).toBe(true);
    await expect(store.readEnvelope(run.runId, "clarify")).resolves.toMatchObject({
      status: "success",
      summary: "clarified",
    });
  });

  it("treats agent success as a candidate until its completion contract passes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-completion-stage-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "verified",
      taskYaml: "id: t\ngoal: g\n",
    });
    const stage = {
      id: "clarify",
      system_prompt: "x",
      model: "anthropic/claude-sonnet-4-5",
      payload_schema: {
        type: "object",
        properties: { changed_files: { type: "array", items: { type: "string" } } },
        required: ["changed_files"],
      },
    };
    const completion = {
      mode: "all" as const,
      checks: [
        { id: "payload", type: "payload_schema" as const },
        {
          id: "self-review",
          type: "checklist" as const,
          items: ["Implementation matches the approved plan"],
        },
      ],
    };
    const dag = {
      nodes: [{ id: "clarify", needs: null, ancestors: [], stageIndex: 0, completion }],
      roots: ["clarify"],
      childrenOf: {},
    };

    const passed = await runStage({
      agent: scriptedFakeAgent([{
        type: "emit",
        envelope: {
          status: "success",
          summary: "ready",
          artifacts: [],
          payload: { changed_files: [] },
          checklist_attestations: [{
            check_id: "self-review",
            items: ["Implementation matches the approved plan"],
          }],
        },
      }]),
      store,
      runId: run.runId,
      stage,
      task: { id: "t", goal: "g" },
      dag,
    });
    expect(passed.ok).toBe(true);
    await expect(store.listVerificationCheckResults(run.runId, "clarify")).resolves.toMatchObject([
      { check_id: "payload", status: "passed" },
      { check_id: "self-review", status: "passed" },
    ]);

    const rejectedRun = await store.createRun({
      pipelineId: "verified",
      taskYaml: "id: t\ngoal: g\n",
    });
    const rejected = await runStage({
      agent: scriptedFakeAgent([{
        type: "emit",
        envelope: {
          status: "success",
          summary: "ready",
          artifacts: [],
          payload: { changed_files: [] },
        },
      }]),
      store,
      runId: rejectedRun.runId,
      stage,
      task: { id: "t", goal: "g" },
      dag,
    });
    expect(rejected).toMatchObject({
      ok: false,
      reason: "Completion verification failed: self-review",
    });
    await expect(store.readEnvelope(rejectedRun.runId, "clarify")).rejects.toThrow();
    await expect(store.listVerificationCheckResults(rejectedRun.runId, "clarify")).resolves.toMatchObject([
      { check_id: "payload", status: "passed" },
      { check_id: "self-review", status: "failed" },
    ]);
  });

  it("missing emit fails the stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const agent = scriptedFakeAgent([{ type: "never_emit" }]);
    const result = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "missing emit_stage_envelope" });
  });

  it("agent throw is recorded as stage failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const agent = scriptedFakeAgent([{ type: "throw", message: "boom" }]);
    const result = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "boom" });
  });

  it("covers AE2: stops after first stage failure; second not invoked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const second = vi.fn();
    const agent = scriptedFakeAgent([
      { type: "never_emit" },
      {
        type: "emit",
        envelope: { status: "success", summary: "should not run", artifacts: [] },
      },
    ]);
    const wrapped = {
      openStage(input: Parameters<typeof agent.openStage>[0]) {
        if (input.stage.id === "design-doc") second();
        return agent.openStage(input);
      },
      async runStage(input: Parameters<typeof agent.runStage>[0]) {
        if (input.stage.id === "design-doc") second();
        return agent.runStage(input);
      },
    };

    const result = await runPipeline({
      agent: wrapped,
      store,
      taskPath: SAMPLE_TASK,
      pipeline: LINEAR_EXPLICIT_PIPELINE,
      cwd: fixtures,
    });

    expect(result.ok).toBe(false);
    expect(second).not.toHaveBeenCalled();
    const events = await store.listStageEvents(result.runId, "clarify");
    expect(events.some((e) => e.event === "failed")).toBe(true);
  });

  it("valid checkout stamps checkout_root on the created run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${checkout}\n`,
    );
    const result = await runPipeline({
      agent,
      store,
      taskPath,
      pipeline: pipelinePath("single"),
      cwd: fixtures,
    });
    expect(result.ok).toBe(true);
    const meta = await store.readRunMeta(result.runId);
    expect(meta.checkout_root).toBe(checkout);
  });

  it("CLI checkout override wins over task checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const fromTask = await mkdtemp(path.join(tmpdir(), "sf-from-task-"));
    const fromCli = await mkdtemp(path.join(tmpdir(), "sf-from-cli-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${fromTask}\n`,
    );
    const result = await runPipeline({
      agent,
      store,
      taskPath,
      pipeline: pipelinePath("single"),
      cwd: fixtures,
      checkoutOverride: fromCli,
    });
    expect(result.ok).toBe(true);
    const meta = await store.readRunMeta(result.runId);
    expect(meta.checkout_root).toBe(fromCli);
  });

  it("missing checkout throws before createRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const missing = path.join(root, "does-not-exist");
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${missing}\n`,
    );
    const before = await store.listRuns();
    await expect(
      runPipeline({
        agent,
        store,
        taskPath,
        pipeline: pipelinePath("single"),
        cwd: fixtures,
      }),
    ).rejects.toThrow(/does not exist/);
    const after = await store.listRuns();
    expect(after).toHaveLength(before.length);
  });

  it("checkout that is a file (not a directory) throws before createRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const notDir = path.join(root, "checkout-file");
    await writeFile(notDir, "not a directory\n");
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${notDir}\n`,
    );
    const before = await store.listRuns();
    await expect(
      runPipeline({
        agent,
        store,
        taskPath,
        pipeline: pipelinePath("single"),
        cwd: fixtures,
      }),
    ).rejects.toThrow(/not a directory/);
    const after = await store.listRuns();
    expect(after).toHaveLength(before.length);
  });

  it.skipIf(!permsEnforced)("checkout without R/W/X throws before createRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-ro-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${checkout}\n`,
    );
    await chmod(checkout, 0o000);
    try {
      const before = await store.listRuns();
      await expect(
        runPipeline({
          agent,
          store,
          taskPath,
          pipeline: pipelinePath("single"),
          cwd: fixtures,
        }),
      ).rejects.toThrow(/not readable\/writable\/searchable/);
      const after = await store.listRuns();
      expect(after).toHaveLength(before.length);
    } finally {
      await chmod(checkout, 0o700);
    }
  });

  it.skipIf(!permsEnforced)("checkout without search (X) permission throws before createRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-nx-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${checkout}\n`,
    );
    await chmod(checkout, 0o600);
    try {
      const before = await store.listRuns();
      await expect(
        runPipeline({
          agent,
          store,
          taskPath,
          pipeline: pipelinePath("single"),
          cwd: fixtures,
        }),
      ).rejects.toThrow(/not readable\/writable\/searchable/);
      const after = await store.listRuns();
      expect(after).toHaveLength(before.length);
    } finally {
      await chmod(checkout, 0o700);
    }
  });

  it("whitespace-only checkout fails eagerly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const before = await store.listRuns();
    await expect(
      runPipeline({
        agent,
        store,
        taskPath: SAMPLE_TASK,
        pipeline: pipelinePath("single"),
        cwd: fixtures,
        checkoutOverride: "   ",
      }),
    ).rejects.toThrow(/whitespace-only/);
    const after = await store.listRuns();
    expect(after).toHaveLength(before.length);
  });

  it("no checkout creates run without checkout_root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const result = await runPipeline({
      agent,
      store,
      taskPath: SAMPLE_TASK,
      pipeline: pipelinePath("single"),
      cwd: fixtures,
    });
    expect(result.ok).toBe(true);
    const meta = await store.readRunMeta(result.runId);
    expect(meta.checkout_root).toBeUndefined();
  });

  it("bound run passes checkout as agent cwd and dual roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${checkout}\n`,
    );
    const result = await runPipeline({
      agent,
      store,
      taskPath,
      pipeline: pipelinePath("single"),
      cwd: fixtures,
    });
    expect(result.ok).toBe(true);
    expect(agent.recorded).toHaveLength(1);
    const roots = agent.recorded[0]!;
    expect(roots.cwd).toBe(checkout);
    expect(roots.runWorkspaceDir).toBe(store.getWorkspaceDir(result.runId));
    expect(roots.checkoutRoot).toBe(checkout);
    expect(roots.cwd).not.toBe(roots.runWorkspaceDir);
  });

  it("unbound run keeps cwd equal to runWorkspaceDir without checkoutRoot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const result = await runPipeline({
      agent,
      store,
      taskPath: SAMPLE_TASK,
      pipeline: pipelinePath("single"),
      cwd: fixtures,
    });
    expect(result.ok).toBe(true);
    expect(agent.recorded).toHaveLength(1);
    const roots = agent.recorded[0]!;
    expect(roots.cwd).toBe(roots.runWorkspaceDir);
    expect(roots.runWorkspaceDir).toBe(store.getWorkspaceDir(result.runId));
    expect(roots.checkoutRoot).toBeUndefined();
  });

  it("all stages in a bound run share the same cwd and checkoutRoot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "s1",
          artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
        },
      },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "s2",
          artifacts: ["stages/design-doc/attempts/1/artifacts/b.md"],
        },
      },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "s3",
          artifacts: ["stages/implementation-plan/attempts/1/artifacts/c.md"],
        },
      },
    ]);
    const taskPath = path.join(root, "task.yaml");
    await writeFile(
      taskPath,
      `id: bound\ngoal: g\ncheckout: ${checkout}\n`,
    );
    const result = await runPipeline({
      agent,
      store,
      taskPath,
      pipeline: LINEAR_EXPLICIT_PIPELINE,
      cwd: fixtures,
    });
    expect(result.ok).toBe(true);
    expect(agent.recorded).toHaveLength(3);
    const workspace = store.getWorkspaceDir(result.runId);
    for (const roots of agent.recorded) {
      expect(roots.cwd).toBe(checkout);
      expect(roots.checkoutRoot).toBe(checkout);
      expect(roots.runWorkspaceDir).toBe(workspace);
    }
  });

  it("rerun without CLI override uses snapshotted task checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pipe-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "rerun", artifacts: [] },
      },
    ]);
    const taskYaml = `id: bound\ngoal: g\ncheckout: ${checkout}\n`;
    const source = await store.createRun({
      pipelineId: "single",
      pipelinePath: SINGLE_PIPELINE,
      taskYaml,
      taskId: "bound",
      checkoutRoot: checkout,
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const result = await manager.rerun(source.runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runId).not.toBe(source.runId);

    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const meta = await store.readRunMeta(result.runId);
    expect(meta.checkout_root).toBe(checkout);
  });
});
