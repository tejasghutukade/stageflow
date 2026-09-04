import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRunStore } from "../src/runstore/createStore.js";
import { createVerifiedStageExecution } from "../src/runtime/verifiedStageExecution.js";

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
});
