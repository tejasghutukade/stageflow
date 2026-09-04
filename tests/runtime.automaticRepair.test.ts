import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StageRunInput } from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { runPipeline } from "../src/runtime/pipelineRunner.js";
import { createRunStore } from "../src/runstore/createStore.js";

async function writeRepairCatalog(
  root: string,
  maxAttempts = 2,
  mode: "repair" | "manual" = "repair",
): Promise<string> {
  await writeFile(
    path.join(root, "implement.yaml"),
    [
      "id: implement",
      "system_prompt: Implement the approved work.",
      "model: anthropic/claude-sonnet-4-5",
      "",
    ].join("\n"),
  );
  const pipeline = path.join(root, "repair.pipeline.yaml");
  await writeFile(
    pipeline,
    [
      "id: repair-demo",
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
      `      mode: ${mode}`,
      ...(mode === "repair" ? [`      max_attempts: ${maxAttempts}`] : []),
      "      retry_safety: idempotent",
      "      include_failed_checks: true",
      "",
    ].join("\n"),
  );
  return pipeline;
}

describe("automatic completion repair", () => {
  it("starts a fresh attempt with failed-check evidence and accepts its verified repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-automatic-repair-"));
    const pipeline = await writeRepairCatalog(root);
    const store = createRunStore({ rootDir: root });
    const base = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "first candidate", artifacts: [] } },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "repaired candidate",
          artifacts: [],
          checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
        },
      },
    ]);
    const inputs: StageRunInput[] = [];
    const agent = {
      openStage(input: StageRunInput) {
        inputs.push(input);
        return base.openStage(input);
      },
      runStage(input: StageRunInput) {
        return base.runStage(input);
      },
    };

    const result = await runPipeline({
      agent,
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });

    expect(result).toMatchObject({ ok: true, outcome: "succeeded" });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.repairContext).toMatchObject({
      prior_attempt: 1,
      failed_checks: [{ id: "self-review", type: "checklist" }],
    });
    await expect(store.countStageAttempts(result.runId, "implement")).resolves.toBe(2);
    await expect(
      store.listVerificationCheckResults(result.runId, "implement", 1),
    ).resolves.toMatchObject([{ check_id: "self-review", status: "failed" }]);
    await expect(
      store.listVerificationCheckResults(result.runId, "implement", 2),
    ).resolves.toMatchObject([{ check_id: "self-review", status: "passed" }]);
    await expect(
      store.getStageExecution(result.runId, "implement", 1),
    ).resolves.toMatchObject({ verification_outcome: "failed" });
    await expect(
      store.getStageExecution(result.runId, "implement", 2),
    ).resolves.toMatchObject({ verification_outcome: "passed" });
  });

  it("ends honestly when the automatic-repair attempt budget is exhausted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-automatic-repair-cap-"));
    const pipeline = await writeRepairCatalog(root, 2);
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "candidate one", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "candidate two", artifacts: [] } },
    ]);

    const result = await runPipeline({
      agent,
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      reason: "Completion verification failed: self-review",
    });
    await expect(store.countStageAttempts(result.runId, "implement")).resolves.toBe(2);
  });

  it("does not automatically retry a manual-recovery stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-manual-recovery-"));
    const pipeline = await writeRepairCatalog(root, 2, "manual");
    const store = createRunStore({ rootDir: root });
    const base = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "candidate one", artifacts: [] } },
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "should not run",
          artifacts: [],
          checklist_attestations: [{ check_id: "self-review", items: ["Tests pass"] }],
        },
      },
    ]);
    const inputs: StageRunInput[] = [];
    const agent = {
      openStage(input: StageRunInput) {
        inputs.push(input);
        return base.openStage(input);
      },
      runStage(input: StageRunInput) {
        return base.runStage(input);
      },
    };

    const result = await runPipeline({
      agent,
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });

    expect(result).toMatchObject({ ok: false, outcome: "failed" });
    expect(inputs).toHaveLength(1);
    await expect(store.countStageAttempts(result.runId, "implement")).resolves.toBe(1);
  });

  it("does not treat an agent failure as a completion-repair trigger", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-agent-failure-no-repair-"));
    const pipeline = await writeRepairCatalog(root, 3, "repair");
    const store = createRunStore({ rootDir: root });

    const result = await runPipeline({
      agent: scriptedFakeAgent([{ type: "never_emit" }]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline,
      cwd: root,
      executionMode: "inprocess",
    });

    expect(result).toMatchObject({ ok: false, outcome: "failed" });
    await expect(store.countStageAttempts(result.runId, "implement")).resolves.toBe(1);
    await expect(
      store.getLatestStageExecution(result.runId, "implement"),
    ).resolves.toMatchObject({ verification_outcome: "not_run" });
  });
});
