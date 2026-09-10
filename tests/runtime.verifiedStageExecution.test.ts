import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import { createVerifiedStageExecution } from "../src/runtime/verifiedStageExecution.js";
import { COMPLETION_VERIFICATION_FAILURE_PREFIX } from "../src/types/completion.js";

describe("verified stage execution", () => {
  it("accepts a candidate only after persisting its completion evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-verified-execution-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "verified",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createStageExecution(run.runId, "implement");

    const execution = createVerifiedStageExecution({
      store,
      runId: run.runId,
      stageId: "implement",
      attempt: 1,
      stage: {
        id: "implement",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      dag: {
        nodes: [{
          id: "implement",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          completion: {
            mode: "all",
            checks: [{ id: "self-review", type: "checklist", items: ["Tests pass"] }],
          },
        }],
        roots: ["implement"],
        childrenOf: {},
      },
      roots: {
        mode: "unbound",
        cwd: run.workspaceDir,
        runWorkspaceDir: run.workspaceDir,
        agentDir: path.join(run.workspaceDir, "agent"),
        attempt: 1,
      },
    });

    await execution.prepare();
    await expect(execution.verify({
      ok: true,
      envelope: {
        status: "success",
        summary: "done",
        artifacts: [],
        checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(
      store.listVerificationCheckResults(run.runId, "implement", 1),
    ).resolves.toMatchObject([{ check_id: "self-review", status: "passed" }]);
    await expect(
      store.getStageExecution(run.runId, "implement", 1),
    ).resolves.toMatchObject({ verification_outcome: "passed" });
  });

  it("records a failed disposition when completion checks reject a candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-verified-execution-failed-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "verified",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createStageExecution(run.runId, "implement");

    const execution = createVerifiedStageExecution({
      store,
      runId: run.runId,
      stageId: "implement",
      attempt: 1,
      stage: {
        id: "implement",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      dag: {
        nodes: [{
          id: "implement",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          completion: {
            mode: "all",
            checks: [{ id: "self-review", type: "checklist", items: ["Tests pass"] }],
          },
        }],
        roots: ["implement"],
        childrenOf: {},
      },
      roots: {
        mode: "unbound",
        cwd: run.workspaceDir,
        runWorkspaceDir: run.workspaceDir,
        agentDir: path.join(run.workspaceDir, "agent"),
        attempt: 1,
      },
    });

    await expect(execution.verify({
      ok: true,
      envelope: { status: "success", summary: "done", artifacts: [] },
    })).resolves.toMatchObject({ ok: false });
    await expect(
      store.getStageExecution(run.runId, "implement", 1),
    ).resolves.toMatchObject({ verification_outcome: "failed" });
  });

  it("when: [after] command failure prefixes Completion verification failed", async () => {
    const catalog = await mkdtemp(path.join(tmpdir(), "sf-verify-after-cmd-"));
    await writeFile(
      path.join(catalog, "demo.pipeline.yaml"),
      [
        "id: demo",
        "stages:",
        "  - id: implement",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: tests",
        "        type: command",
        '        run: "exit 1"',
        "        when: [after]",
        "",
      ].join("\n"),
    );
    const loaded = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: catalog });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-verify-after-cmd-run-"));
    const store = createRunStore({ rootDir: storeRoot });
    const run = await store.createRun({
      pipelineId: "demo",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createStageExecution(run.runId, "implement");

    const execution = createVerifiedStageExecution({
      store,
      runId: run.runId,
      stageId: "implement",
      attempt: 1,
      stage: loaded.value.stages[0]!,
      dag: loaded.value.dag,
      roots: {
        mode: "unbound",
        cwd: run.workspaceDir,
        runWorkspaceDir: run.workspaceDir,
        agentDir: path.join(run.workspaceDir, "agent"),
        attempt: 1,
      },
    });

    await execution.prepare();
    await expect(
      execution.verify({
        ok: true,
        envelope: { status: "success", summary: "done", artifacts: [] },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: `${COMPLETION_VERIFICATION_FAILURE_PREFIX} tests`,
    });
  });

  it("type: artifact when: [emit, after] requires a nonempty on-disk file after emit", async () => {
    const catalog = await mkdtemp(path.join(tmpdir(), "sf-verify-artifact-phases-"));
    await writeFile(
      path.join(catalog, "demo.pipeline.yaml"),
      [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: report",
        "        type: artifact",
        "        basename: report.md",
        "        nonempty: true",
        "        when: [emit, after]",
        "",
      ].join("\n"),
    );
    const loaded = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: catalog });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-verify-artifact-run-"));
    const store = createRunStore({ rootDir: storeRoot });
    const run = await store.createRun({
      pipelineId: "demo",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createStageExecution(run.runId, "plan");
    const artifactsDir = attemptArtifactsDir(run.workspaceDir, "plan", 1);
    const candidate = {
      ok: true as const,
      envelope: {
        status: "success" as const,
        summary: "done",
        artifacts: ["stages/plan/attempts/1/artifacts/report.md"],
      },
    };
    const execution = createVerifiedStageExecution({
      store,
      runId: run.runId,
      stageId: "plan",
      attempt: 1,
      stage: loaded.value.stages[0]!,
      dag: loaded.value.dag,
      roots: {
        mode: "unbound",
        cwd: run.workspaceDir,
        runWorkspaceDir: run.workspaceDir,
        agentDir: path.join(run.workspaceDir, "agent"),
        attempt: 1,
      },
    });

    await execution.prepare();
    await expect(execution.verify(candidate)).resolves.toMatchObject({
      ok: false,
      reason: `${COMPLETION_VERIFICATION_FAILURE_PREFIX} report`,
    });

    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, "report.md"), "");
    await expect(execution.verify(candidate)).resolves.toMatchObject({
      ok: false,
      reason: `${COMPLETION_VERIFICATION_FAILURE_PREFIX} report`,
    });

    await writeFile(path.join(artifactsDir, "report.md"), "contents\n");
    await expect(execution.verify(candidate)).resolves.toMatchObject({ ok: true });
  });
});
