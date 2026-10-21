import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRunStore,
  DISK_STORE_REJECTED,
} from "../src/runstore/createStore.js";
import { SqliteRunStore } from "../src/runstore/sqlite/SqliteRunStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { plantDiskEraRun } from "./helpers/plantDiskEraRun.js";

describe("sqlite run store", () => {
  it("persists runs, events, and envelopes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.updateRunStatus(run.runId, "succeeded");

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("succeeded");
    expect(detail.stages).toHaveLength(1);
    expect(detail.stages[0]?.envelope?.summary).toBe("ok");
    expect(detail.task_yaml).toContain("goal: g");

    const listed = await store.listRuns();
    expect(listed.some((r) => r.run_id === run.runId)).toBe(true);

    const meta = await store.readRunMeta(run.runId);
    expect(meta.checkout_root).toBeUndefined();
    expect(meta.git_sha).toBeUndefined();
    expect(meta.ci_pr_url).toBeUndefined();
    expect(meta.ci_job_url).toBeUndefined();
  });

  it("persists repository binding fields and preallocated runId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-binding-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const runId = "2026-09-21T00-00-00-aabbcc";
    const checkout = "/data/worktrees/" + runId;
    const sha = "c".repeat(40);
    const run = await store.createRun({
      runId,
      pipelineId: "docs-only",
      taskYaml: "id: t\nrepository: acme/api\nref: main\n",
      taskId: "t",
      checkoutRoot: checkout,
      repository: "acme/api",
      ref: "main",
      resolvedSha: sha,
      runBranch: `stageflow/run-${runId}`,
      gitAuthorName: "Stageflow",
      gitAuthorEmail: "stageflow@localhost",
    });
    expect(run.runId).toBe(runId);

    const meta = await store.readRunMeta(runId);
    expect(meta.repository).toBe("acme/api");
    expect(meta.ref).toBe("main");
    expect(meta.resolved_sha).toBe(sha);
    expect(meta.run_branch).toBe(`stageflow/run-${runId}`);
    expect(meta.checkout_root).toBe(checkout);
    expect(meta.git_author_name).toBe("Stageflow");
    expect(meta.git_author_email).toBe("stageflow@localhost");

    const detail = await store.readRun(runId);
    expect(detail.binding).toEqual({
      kind: "repository",
      repository: "acme/api",
      ref: "main",
      resolved_sha: sha,
      run_branch: `stageflow/run-${runId}`,
      checkout_root: checkout,
    });

    const listed = await store.listRuns();
    const summary = listed.find((r) => r.run_id === runId);
    expect(summary?.binding).toEqual({
      kind: "repository",
      repository: "acme/api",
      ref: "main",
      resolved_sha: sha,
    });
    expect(summary?.binding).not.toHaveProperty("checkout_root");
    expect(summary?.binding).not.toHaveProperty("run_branch");
  });

  it.each([
    {
      name: "all CI fields",
      input: {
        gitSha: "abc123def",
        ciPrUrl: "https://github.com/acme/repo/pull/42",
        ciJobUrl: "https://github.com/acme/repo/actions/runs/99",
      },
      expected: {
        git_sha: "abc123def",
        ci_pr_url: "https://github.com/acme/repo/pull/42",
        ci_job_url: "https://github.com/acme/repo/actions/runs/99",
      },
    },
    { name: "no CI fields", input: {}, expected: {} },
    {
      name: "only gitSha",
      input: { gitSha: "deadbeef" },
      expected: { git_sha: "deadbeef" },
    },
  ])("round-trips CI identity through readRunMeta: $name", async ({ input, expected }) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-ci-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      ...input,
    });
    const meta = await store.readRunMeta(run.runId);
    expect({
      git_sha: meta.git_sha,
      ci_pr_url: meta.ci_pr_url,
      ci_job_url: meta.ci_job_url,
    }).toEqual({
      git_sha: undefined,
      ci_pr_url: undefined,
      ci_job_url: undefined,
      ...expected,
    });
  });

  it("rejects kind disk and SF_STORE=disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reject-disk-"));
    expect(() => createRunStore({ rootDir: root, kind: "disk" })).toThrow(
      DISK_STORE_REJECTED,
    );

    const prev = process.env.SF_STORE;
    process.env.SF_STORE = "disk";
    try {
      expect(() => createRunStore({ rootDir: root })).toThrow(DISK_STORE_REJECTED);
    } finally {
      if (prev === undefined) delete process.env.SF_STORE;
      else process.env.SF_STORE = prev;
    }
  });

  it("imports existing disk runs when sqlite db is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const runId = "legacy-disk-run";
    await plantDiskEraRun(root, {
      runId,
      pipelineId: "docs-only",
      taskYaml: "id: legacy\ngoal: migrate me\n",
      taskId: "legacy",
      checkoutRoot: checkout,
      status: "succeeded",
      stageId: "clarify",
      events: [{ event: "started" }, { event: "succeeded" }],
      envelope: {
        status: "success",
        summary: "from disk",
        artifacts: [],
      },
    });

    const sqlite = createRunStore({ rootDir: root, kind: "sqlite" });
    if (sqlite instanceof SqliteRunStore) {
      await sqlite.ready();
    }
    const detail = await sqlite.readRun(runId);
    expect(detail.task_id).toBe("legacy");
    expect(detail.stages[0]?.envelope?.summary).toBe("from disk");
    expect(detail.status).toBe("succeeded");
    const meta = await sqlite.readRunMeta(runId);
    expect(meta.checkout_root).toBe(checkout);
  });

  it("does not re-import when sqlite already has rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate2-"));
    const sqlite = createRunStore({ rootDir: root, kind: "sqlite" });
    await sqlite.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: only\ngoal: db\n",
      taskId: "only",
    });

    const oldDir = path.join(storeRootFor(root), "runs", "should-not-import");
    await mkdir(oldDir, { recursive: true });
    await writeFile(
      path.join(oldDir, "meta.json"),
      `${JSON.stringify({
        run_id: "should-not-import",
        pipeline_id: "docs-only",
        created_at: "2020-01-01T00:00:00.000Z",
        status: "succeeded",
      }, null, 2)}\n`,
    );
    await writeFile(path.join(oldDir, "task.copy.yaml"), "id: skip\ngoal: no\n");

    const again = createRunStore({ rootDir: root, kind: "sqlite" });
    if (again instanceof SqliteRunStore) {
      await again.ready();
    }
    const runs = await again.listRuns();
    expect(runs.some((r) => r.run_id === "should-not-import")).toBe(false);
    expect(runs.some((r) => r.task_id === "only")).toBe(true);
  });

  it("derives waiting_for_input and keeps run running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-wait-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: wait\n",
      taskId: "t",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const waiting = await store.readRun(run.runId);
    expect(waiting.stages[0]?.status).toBe("waiting_for_input");
    expect(waiting.status).toBe("running");

    await store.appendStageEvent(run.runId, "clarify", { event: "resumed" });
    const resumed = await store.readRun(run.runId);
    expect(resumed.stages[0]?.status).toBe("running");
    expect(resumed.status).toBe("running");
  });

  it("handles concurrent writers from separate connections without SQLITE_BUSY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-concurrent-"));
    const primary = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await primary.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const writerA = createRunStore({ rootDir: root, kind: "sqlite" });
    const writerB = createRunStore({ rootDir: root, kind: "sqlite" });
    const writerC = createRunStore({ rootDir: root, kind: "sqlite" });

    await Promise.all([
      writerA.appendStageEvent(run.runId, "branch-a", { event: "started" }),
      writerB.appendStageEvent(run.runId, "branch-b", { event: "started" }),
      writerC.appendStageEvent(run.runId, "branch-c", { event: "started" }),
    ]);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.all([
          writerA.appendStageEvent(run.runId, "branch-a", {
            event: "message",
            role: "assistant",
            text: `a-${i}`,
          }),
          writerB.appendStageEvent(run.runId, "branch-b", {
            event: "message",
            role: "assistant",
            text: `b-${i}`,
          }),
          writerC.appendStageEvent(run.runId, "branch-c", {
            event: "message",
            role: "assistant",
            text: `c-${i}`,
          }),
        ]),
      ),
    );

    const detail = await primary.readRun(run.runId);
    const byStage = Object.fromEntries(
      detail.stages.map((s) => [s.stage_id, s.events.length]),
    );
    expect(byStage["branch-a"]).toBe(11);
    expect(byStage["branch-b"]).toBe(11);
    expect(byStage["branch-c"]).toBe(11);
  });

  describe("listRuns filters", () => {
    it("returns all runs newest-first with no filter", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-list-all-"));
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      const a = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.createRun({
        pipelineId: "single",
        taskYaml: "id: t\ngoal: g\n",
      });

      const listed = await store.listRuns();
      expect(listed.map((r) => r.run_id)).toEqual([b.runId, a.runId]);
    });

    it("filters by status", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-list-status-"));
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      const running = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      const failed = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.updateRunStatus(failed.runId, "failed");

      const listed = await store.listRuns({ status: "failed" });
      expect(listed.map((r) => r.run_id)).toEqual([failed.runId]);
      expect(listed.every((r) => r.status === "failed")).toBe(true);
      expect(listed.some((r) => r.run_id === running.runId)).toBe(false);
    });

    it("filters by since (created_at lower bound)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-list-since-"));
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      const older = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await new Promise((r) => setTimeout(r, 5));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      const newer = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });

      const listed = await store.listRuns({ since: cutoff });
      expect(listed.map((r) => r.run_id)).toEqual([newer.runId]);
      expect(listed.some((r) => r.run_id === older.runId)).toBe(false);
    });

    it("filters by pipeline id or path", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-list-pipe-"));
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      const pipePath = path.join(root, "pipelines", "docs-only.pipeline.yaml");
      const match = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
        pipelinePath: pipePath,
      });
      await store.createRun({
        pipelineId: "single",
        taskYaml: "id: t\ngoal: g\n",
        pipelinePath: path.join(root, "pipelines", "single.pipeline.yaml"),
      });

      const byId = await store.listRuns({ pipeline: "docs-only" });
      expect(byId.map((r) => r.run_id)).toEqual([match.runId]);

      const byPath = await store.listRuns({ pipeline: pipePath });
      expect(byPath.map((r) => r.run_id)).toEqual([match.runId]);
    });

    it("ANDs combined filters", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-list-and-"));
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      const keep = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.updateRunStatus(keep.runId, "succeeded");
      const wrongStatus = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.updateRunStatus(wrongStatus.runId, "failed");
      await store.createRun({
        pipelineId: "single",
        taskYaml: "id: t\ngoal: g\n",
      });

      const listed = await store.listRuns({
        status: "succeeded",
        pipeline: "docs-only",
      });
      expect(listed.map((r) => r.run_id)).toEqual([keep.runId]);
    });
  });

  it("createRun accepts optional status and defaults to running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-status-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const running = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const queued = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      status: "queued",
    });
    expect((await store.readRunMeta(running.runId)).status).toBe("running");
    expect((await store.readRunMeta(queued.runId)).status).toBe("queued");
    const listedQueued = await store.listRuns({ status: "queued" });
    expect(listedQueued.map((r) => r.run_id)).toEqual([queued.runId]);
  });

  it("sets finished_at once on first terminal transition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-finished-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    expect((await store.readRunMeta(run.runId)).finished_at).toBeUndefined();

    await store.updateRunStatus(run.runId, "succeeded");
    const first = await store.readRunMeta(run.runId);
    expect(first.finished_at).toBeDefined();
    expect(first.status).toBe("succeeded");

    await new Promise((r) => setTimeout(r, 5));
    await store.updateRunStatus(run.runId, "failed");
    const second = await store.readRunMeta(run.runId);
    expect(second.status).toBe("failed");
    expect(second.finished_at).toBe(first.finished_at);

    const detail = await store.readRun(run.runId);
    expect(detail.finished_at).toBe(first.finished_at);
  });

  it("threads lifecycle meta fields through readRun and listRuns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-lifecycle-meta-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const dbPath = path.join(storeRootFor(root), "state.db");
    const db = new Database(dbPath);
    db.prepare(
      `UPDATE runs SET cancel_reason = ?, finished_at = ?, slimmed_at = ?, disk_bytes = ?, disk_measured_at = ? WHERE run_id = ?`,
    ).run(
      "operator request",
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      4096,
      "2026-09-02T01:00:00.000Z",
      run.runId,
    );
    db.close();

    const meta = await store.readRunMeta(run.runId);
    expect(meta.cancel_reason).toBe("operator request");
    expect(meta.finished_at).toBe("2026-09-01T00:00:00.000Z");
    expect(meta.slimmed_at).toBe("2026-09-02T00:00:00.000Z");
    expect(meta.disk_bytes).toBe(4096);
    expect(meta.disk_measured_at).toBe("2026-09-02T01:00:00.000Z");

    const detail = await store.readRun(run.runId);
    expect(detail.cancel_reason).toBe("operator request");
    expect(detail.disk_bytes).toBe(4096);

    const listed = await store.listRuns();
    const row = listed.find((r) => r.run_id === run.runId);
    expect(row?.cancel_reason).toBe("operator request");
    expect(row?.disk_bytes).toBe(4096);
  });

  it("close checkpoints WAL and allows reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-close-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    for (let i = 0; i < 40; i++) {
      await store.appendStageEvent(run.runId, "clarify", {
        event: "started",
      });
      await store.updateRunStatus(run.runId, i % 2 === 0 ? "running" : "created");
    }
    await store.close();

    const walPath = path.join(storeRootFor(root), "state.db-wal");
    try {
      const wal = await stat(walPath);
      expect(wal.size).toBeLessThan(64 * 1024);
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }

    const reopened = createRunStore({ rootDir: root, kind: "sqlite" });
    const detail = await reopened.readRun(run.runId);
    expect(detail.run_id).toBe(run.runId);
    await reopened.close();
  });
});
