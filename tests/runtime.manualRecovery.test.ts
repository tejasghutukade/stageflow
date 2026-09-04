import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StageRunInput } from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { readStageVerificationHistory } from "../src/runstore/verificationHistory.js";
import { RunManager } from "../src/runtime/runManager.js";
import { runPipeline } from "../src/runtime/pipelineRunner.js";
import { createRunStore } from "../src/runstore/createStore.js";

async function writeManualRecoveryCatalog(root: string): Promise<string> {
  await writeFile(
    path.join(root, "implement.yaml"),
    [
      "id: implement",
      "system_prompt: Implement the approved work.",
      "model: anthropic/claude-sonnet-4-5",
      "",
    ].join("\n"),
  );
  const pipeline = path.join(root, "manual.pipeline.yaml");
  await writeFile(
    pipeline,
    [
      "id: manual-recovery-demo",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      mode: all",
      "      checks:",
      "        - id: self-review",
      "          type: checklist",
      "          items: [Tests pass]",
      "    recovery:",
      "      mode: manual",
      "      retry_safety: idempotent",
      "      include_failed_checks: true",
      "",
    ].join("\n"),
  );
  return pipeline;
}

describe("manual completion recovery", () => {
  it("starts only after operator approval and gives the recovery agent guidance plus failed checks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-manual-recover-"));
    const pipeline = await writeManualRecoveryCatalog(root);
    const store = createRunStore({ rootDir: root });
    const initial = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });
    expect(initial).toMatchObject({ ok: false, outcome: "failed" });
    await expect(
      store.getLatestStageExecution(initial.runId, "implement"),
    ).resolves.toMatchObject({ verification_outcome: "failed" });

    const inputs: StageRunInput[] = [];
    const base = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "recovered",
          artifacts: [],
          checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
        },
      },
    ]);
    const manager = new RunManager({
      agent: {
        openStage(input) {
          inputs.push(input);
          return base.openStage(input);
        },
        runStage(input) {
          return base.runStage(input);
        },
      },
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });

    await expect(manager.retryStage(initial.runId, "implement")).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Stage uses manual recovery; use the manual recovery action instead of retry",
    });

    await store.updateStageExecution(initial.runId, "implement", 1, {
      verification_outcome: "not_run",
    });
    await expect(
      manager.recoverManualStage(initial.runId, "implement"),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Manual recovery is only available after a completion verification failure",
    });
    await store.updateStageExecution(initial.runId, "implement", 1, {
      verification_outcome: "failed",
    });

    const recovered = await manager.recoverManualStage(
      initial.runId,
      "implement",
      "Run the focused tests and fix the reported failure.",
    );

    expect(recovered).toMatchObject({ ok: true, attemptIndex: 2 });
    if (recovered.ok) {
      await recovered.done;
    }
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.repairContext).toMatchObject({
      prior_attempt: 1,
      operator_guidance: "Run the focused tests and fix the reported failure.",
      failed_checks: [{ id: "self-review", type: "checklist" }],
    });
    await expect(store.readRunMeta(initial.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      store.getLatestStageExecution(initial.runId, "implement"),
    ).resolves.toMatchObject({ verification_outcome: "passed" });
    await expect(
      store.listStageEvents(initial.runId, "implement", 2),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "manual_recovery_requested",
          guidance: "Run the focused tests and fix the reported failure.",
        }),
      ]),
    );
  });

  it("records a stop decision and will not restart the stage in this run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-manual-stop-"));
    const pipeline = await writeManualRecoveryCatalog(root);
    const store = createRunStore({ rootDir: root });
    const initial = await runPipeline({
      agent: scriptedFakeAgent([
        { type: "emit", envelope: { status: "success", summary: "candidate", artifacts: [] } },
      ]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });

    await expect(manager.stopManualRecovery(initial.runId, "implement")).resolves.toEqual({
      ok: true,
      runId: initial.runId,
      stageId: "implement",
    });
    await expect(
      readStageVerificationHistory(store, initial.runId, "implement"),
    ).resolves.toMatchObject({
      manual_recovery: { status: "stopped", failed_attempt: 1 },
    });
    await expect(
      manager.recoverManualStage(initial.runId, "implement"),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Manual recovery has been stopped for this stage",
    });
    await expect(manager.retryStage(initial.runId, "implement")).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "Stage uses manual recovery; use the manual recovery action instead of retry",
    });
  });
});
