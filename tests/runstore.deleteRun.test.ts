import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { A2aStore } from "../src/a2a/store.js";
import {
  ensureBareCache,
  resetBareCacheStateForTests,
  setBareCacheRemoteUrlOverrideForTests,
} from "../src/git/cache.js";
import { runGitSync } from "../src/git/exec.js";
import { worktreeAdd } from "../src/git/operations.js";
import {
  resetGlobalStageflowHomeForTests,
} from "../src/project/globalHome.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import type { FeedbackLoopConfig } from "../src/types/pipeline.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { deleteRunEverywhere } from "../src/runtime/runDeletion.js";
import { worktreePathForRun } from "../src/runtime/repositoryMaterialize.js";
import { isMutatingApi } from "../src/server/http.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { RunManager } from "../src/runtime/runManager.js";

const gitAvailable = (() => {
  try {
    runGitSync({ args: ["--version"], timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

const temps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

const policy: FeedbackLoopConfig = {
  target: "plan",
  max_replays: 2,
  on_max_replays: "require_continue",
  replay_session: "resume",
};

const feedbackEnvelope: StageEnvelope = {
  status: "success",
  summary: "send back",
  artifacts: [],
  feedback_loop: {
    action: "send_back",
    target: "plan",
  },
};

function stashEnv(keys: string[]): void {
  for (const key of keys) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(keys: string[]): void {
  for (const key of keys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function countRows(db: Database.Database, table: string, runId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(runId) as {
      n: number;
    }
  ).n;
}

const RUN_SCOPED_TABLES = [
  "stage_events",
  "verification_check_results",
  "stage_executions",
  "feedback_replay_stage_passes",
  "feedback_replays",
  "feedback_loops",
  "fork_generations",
  "stages",
  "run_submissions",
  "runs",
] as const;

async function createSourceRepo(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-u3-src-"));
  temps.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README"), "hello\n");
  git(root, ["add", "README"]);
  git(root, ["commit", "-m", "init"]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  return { root, sha };
}

beforeEach(async () => {
  stashEnv(["STAGEFLOW_HOME", "GITHUB_TOKEN", "GH_TOKEN"]);
  resetGlobalStageflowHomeForTests();
  resetBareCacheStateForTests();
  setBareCacheRemoteUrlOverrideForTests(null);
  const home = await mkdtemp(path.join(tmpdir(), "sf-u3-home-"));
  temps.push(home);
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  process.env.GITHUB_TOKEN = "ghp_TestTokenForU3XXXXXXXXXXXXXXX";
});

afterEach(async () => {
  setBareCacheRemoteUrlOverrideForTests(null);
  resetBareCacheStateForTests();
  restoreEnv(["STAGEFLOW_HOME", "GITHUB_TOKEN", "GH_TOKEN"]);
  resetGlobalStageflowHomeForTests();
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("isMutatingApi DELETE widening", () => {
  it("recognizes DELETE /api/runs/:runId", () => {
    expect(isMutatingApi("DELETE", "/api/runs/abc-123")).toBe(true);
    expect(isMutatingApi("DELETE", "/api/runs/abc-123/cancel")).toBe(false);
    expect(isMutatingApi("GET", "/api/runs/abc-123")).toBe(false);
    expect(isMutatingApi("POST", "/api/runs/abc-123/cancel")).toBe(true);
  });
});

describe("deleteRun store + deleteRunEverywhere", () => {
  it("deletes rows across all ten tables, workspace, worktree, branch, and A2A", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u3-del-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const db = connection;

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      submission: {
        key: "sub-key-u3",
        requestHash: sha256Hex("u3-delete-request"),
      },
    });
    const runId = run.runId;

    await store.appendStageEvent(runId, "build", { event: "started" });
    await store.createStageExecution(runId, "build");
    await store.upsertVerificationCheckResult(runId, "build", {
      check_id: "c1",
      check_type: "command",
      status: "passed",
    });
    await store.writeEnvelope(runId, "build", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });

    await store.createFeedbackLoop(runId, {
      loop_id: "loop-1",
      source_stage_id: "build",
      source_attempt: 1,
      policy,
    });
    await store.createFeedbackReplay(runId, {
      replay_id: "replay-1",
      loop_id: "loop-1",
      source_stage_id: "build",
      source_attempt: 1,
      target_stage_id: "plan",
      replay_number: 1,
      max_replays: 2,
      replay_session: "resume",
      route_stage_ids: ["plan"],
      feedback_envelope: feedbackEnvelope,
    });
    await store.createFeedbackReplayStagePass(runId, {
      replay_id: "replay-1",
      stage_id: "plan",
      stage_attempt: 1,
      session_mode: "resume",
    });
    await store.createForkGeneration(runId, {
      generation_id: "gen-1",
      replay_id: "replay-1",
      fork_parent_stage_id: "plan",
      generation_number: 1,
      clone_stage_ids: ["plan__clone_1"],
    });

    await store.updateRunStatus(runId, "succeeded");

    const workspaceDir = store.getWorkspaceDir(runId);
    expect(existsSync(workspaceDir)).toBe(true);

    let checkoutRoot: string | undefined;
    let cachePath: string | undefined;
    let runBranch: string | undefined;
    if (gitAvailable) {
      const { root: source, sha } = await createSourceRepo();
      setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);
      const repository = "acme/u3-delete";
      runBranch = `stageflow/run-${runId}`;
      checkoutRoot = worktreePathForRun(runId);
      const ensured = await ensureBareCache(repository, "main");
      cachePath = ensured.cachePath;
      mkdirSync(path.dirname(checkoutRoot), { recursive: true });
      await worktreeAdd(cachePath, {
        worktreePath: checkoutRoot,
        branch: runBranch,
        startPoint: sha,
      });
      db.prepare(
        `UPDATE runs SET repository = ?, ref = ?, resolved_sha = ?, checkout_root = ?, run_branch = ? WHERE run_id = ?`,
      ).run(repository, "main", sha, checkoutRoot, runBranch, runId);
    }

    const contextId = a2aStore.ensureContext("caller-u3", undefined);
    const taskId = randomUUID();
    a2aStore.createTask({
      taskId,
      contextId,
      callerId: "caller-u3",
      publicationId: "pub",
      publicationRevision: "1",
      submissionKey: `a2a-${runId}`,
      runId,
    });
    await a2aStore.freezeCompleted(taskId, {
      summary: "done",
      artifacts: [
        { name: "report.txt", bytes: Buffer.from("artifact-bytes") },
      ],
    });
    const artifacts = a2aStore.listArtifacts(taskId);
    expect(artifacts).toHaveLength(1);
    const artifactPath = artifacts[0]!.content_path;
    expect(existsSync(artifactPath)).toBe(true);

    for (const table of RUN_SCOPED_TABLES) {
      expect(countRows(db, table, runId)).toBeGreaterThan(0);
    }

    await deleteRunEverywhere(store, a2aStore, runId);

    for (const table of RUN_SCOPED_TABLES) {
      expect(countRows(db, table, runId)).toBe(0);
    }
    expect(existsSync(workspaceDir)).toBe(false);
    expect(existsSync(artifactPath)).toBe(false);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE run_id = ?`)
          .get(runId) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM a2a_artifacts WHERE task_id = ?`)
          .get(taskId) as { n: number }
      ).n,
    ).toBe(0);

    if (gitAvailable && checkoutRoot && cachePath && runBranch) {
      expect(existsSync(checkoutRoot)).toBe(false);
      expect(git(cachePath, ["branch", "--list", runBranch])).toBe("");
    }

    await expect(store.readRun(runId)).rejects.toThrow(/Run not found/);
  });

  it("succeeds when workspace and worktree are already gone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u3-missing-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "failed");

    const workspaceDir = store.getWorkspaceDir(run.runId);
    await rm(workspaceDir, { recursive: true, force: true });

    if (gitAvailable) {
      const { root: source, sha } = await createSourceRepo();
      setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);
      const repository = "acme/u3-missing";
      const runBranch = `stageflow/run-${run.runId}`;
      const checkoutRoot = worktreePathForRun(run.runId);
      const { cachePath } = await ensureBareCache(repository, "main");
      mkdirSync(path.dirname(checkoutRoot), { recursive: true });
      await worktreeAdd(cachePath, {
        worktreePath: checkoutRoot,
        branch: runBranch,
        startPoint: sha,
      });
      connection
        .prepare(
          `UPDATE runs SET repository = ?, ref = ?, resolved_sha = ?, checkout_root = ?, run_branch = ? WHERE run_id = ?`,
        )
        .run(repository, "main", sha, checkoutRoot, runBranch, run.runId);
      await rm(checkoutRoot, { recursive: true, force: true });
    }

    await deleteRunEverywhere(store, a2aStore, run.runId);
    expect(countRows(connection, "runs", run.runId)).toBe(0);
    await expect(store.readRun(run.runId)).rejects.toThrow(/Run not found/);
  });

  it("throws Run not found on missing runId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u3-404-"));
    temps.push(root);
    const { store } = createRunStoreWithConnection({ rootDir: root });
    await expect(store.deleteRun("does-not-exist")).rejects.toThrow(
      "Run not found: does-not-exist",
    );
  });

  it("force deletes an active run via RunManager", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u3-force-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      a2aStore,
    });

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "running");

    const denied = await manager.deleteRun(run.runId, {
      force: false,
      channel: "cli",
    });
    expect(denied).toEqual({
      ok: false,
      reason: "Run is running and cannot be deleted without force",
      status: 409,
    });
    expect(countRows(connection, "runs", run.runId)).toBe(1);

    const forced = await manager.deleteRun(run.runId, {
      force: true,
      channel: "cli",
    });
    expect(forced).toEqual({ ok: true, runId: run.runId });
    expect(countRows(connection, "runs", run.runId)).toBe(0);
    await expect(store.readRun(run.runId)).rejects.toThrow(/Run not found/);
  });
});
