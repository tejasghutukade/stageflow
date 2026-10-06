import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { RunManager } from "../src/runtime/runManager.js";
import { createCompletedOnlyStageHandle, runStageViaOpen, type AgentPort } from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { RunSubmissionExistsError } from "../src/runstore/submission.js";

const input = { pipeline: path.resolve("tests/fixtures/pipelines/single.pipeline.yaml"), task: { id: "submitted", goal: "Exercise durable starts" } };
const submission = { key: "a2a:invocation-one", requestHash: "a".repeat(64) };

describe("durable run submissions", () => {
  it("starts concurrent identical requests once and rejects conflicting reuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-submit-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent: AgentPort = {
      openStage: vi.fn((stage) => createCompletedOnlyStageHandle({ stageId: stage.stage.id, run: async () => {
        await gate;
        return { ok: true, envelope: { status: "success", summary: "Done", artifacts: [], payload: {} } };
      } })),
      runStage(stage) { return runStageViaOpen(this, stage); },
    };
    const manager = new RunManager({ agent, store, cwd: root, maxConcurrent: 1 });
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => manager.startRunOnce(input, submission)));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(new Set(results.map((result) => result.ok && result.runId)).size).toBe(1);
      expect((await store.listRuns()).length).toBe(1);
      const conflict = await manager.startRunOnce(input, { ...submission, requestHash: "b".repeat(64) });
      expect(conflict).toMatchObject({ ok: false, status: 409 });
      expect(await manager.startRunOnce(input, submission)).toMatchObject({ ok: true, reused: true });
    } finally {
      release();
      await expect.poll(() => manager.getActiveCount()).toBe(0);
    }
    expect(agent.openStage).toHaveBeenCalledTimes(1);
  });

  it("reconnects through the committed submission after a lost response, without launching a worker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-submit-restart-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({ pipelineId: "single", taskYaml: "id: task\ngoal: test\n", submission });
    const reopened = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([]);
    const launch = vi.spyOn(agent, "openStage");
    const manager = new RunManager({ agent, store: reopened, cwd: root });
    expect(await manager.startRunOnce(input, submission)).toEqual({ ok: true, reused: true, runId: created.runId });
    expect(launch).not.toHaveBeenCalled();
    expect(await reopened.listRuns()).toHaveLength(1);
  });

  it("enforces uniqueness at SQLite even across connection owners", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-submit-unique-"));
    const first = createRunStore({ rootDir: root });
    const second = createRunStore({ rootDir: root });
    const request = { pipelineId: "single", taskYaml: "id: task\ngoal: test\n", submission };
    const results = await Promise.allSettled([first.createRun(request), second.createRun(request)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(RunSubmissionExistsError);
    expect(await first.listRuns()).toHaveLength(1);
  });

  it("rolls back run insertion if submission association fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-submit-rollback-"));
    const store = createRunStore({ rootDir: root });
    await store.getRunBySubmission(submission.key);
    const connection = new Database(path.join(storeRootFor(root), "state.db"));
    try {
      connection.exec("CREATE TRIGGER reject_submission BEFORE INSERT ON run_submissions BEGIN SELECT RAISE(ABORT, 'injected association failure'); END");
      await expect(store.createRun({ pipelineId: "single", taskYaml: "id: task\ngoal: test\n", submission })).rejects.toThrow("injected association failure");
      expect(await store.listRuns()).toEqual([]);
      expect(await store.getRunBySubmission(submission.key)).toBeNull();
    } finally { connection.close(); }
  });
});
