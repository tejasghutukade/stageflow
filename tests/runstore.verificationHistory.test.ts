import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { readStageVerificationHistory } from "../src/runstore/verificationHistory.js";

describe("stage verification history", () => {
  it("keeps check evidence grouped with each immutable attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-verification-history-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "verified",
      taskYaml: "id: verify\ngoal: test\n",
      pipelineDag: linearCompatDagSnapshot(["verify"]),
    });

    await store.createStageExecution(run.runId, "verify");
    await store.appendStageEvent(run.runId, "verify", { event: "started" });
    await store.upsertVerificationCheckResult(run.runId, "verify", {
      check_id: "tests",
      check_type: "command",
      status: "failed",
      evidence: { kind: "command", exit_code: 1, stderr: "one test failed" },
    });
    await store.appendStageEvent(run.runId, "verify", {
      event: "failed",
      reason: "Completion verification failed: tests",
    });
    await store.updateStageExecution(run.runId, "verify", 1, { status: "failed" });
    await store.updateStageExecution(run.runId, "verify", 1, {
      verification_outcome: "failed",
    });

    await store.createStageExecution(run.runId, "verify");
    await store.appendStageEvent(run.runId, "verify", { event: "started" }, { attempt: 2 });
    await store.upsertVerificationCheckResult(
      run.runId,
      "verify",
      {
        check_id: "tests",
        check_type: "command",
        status: "passed",
        evidence: { kind: "command", exit_code: 0, stdout: "all pass" },
      },
      { attempt: 2 },
    );
    await store.appendStageEvent(run.runId, "verify", { event: "succeeded" }, { attempt: 2 });
    await store.updateStageExecution(run.runId, "verify", 2, { status: "succeeded" });
    await store.updateStageExecution(run.runId, "verify", 2, {
      verification_outcome: "passed",
    });

    await expect(
      readStageVerificationHistory(store, run.runId, "verify"),
    ).resolves.toEqual({
      run_id: run.runId,
      stage_id: "verify",
      attempts: [
        expect.objectContaining({
          attempt: 1,
          status: "failed",
          verification_outcome: "failed",
          checks: [
            expect.objectContaining({
              check_id: "tests",
              status: "failed",
              evidence: { kind: "command", exit_code: 1, stderr: "one test failed" },
            }),
          ],
        }),
        expect.objectContaining({
          attempt: 2,
          status: "succeeded",
          verification_outcome: "passed",
          checks: [
            expect.objectContaining({
              check_id: "tests",
              status: "passed",
              evidence: { kind: "command", exit_code: 0, stdout: "all pass" },
            }),
          ],
        }),
      ],
    });
  });
});
