import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createRunStore, createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import {
  DAY_MS,
  DEFAULT_RETENTION_WINDOWS,
  retentionDecision,
  retentionWindowsFromEnv,
  type RetentionWindows,
} from "../src/runstore/retention.js";
import {
  getSlimWalkCallCount,
  resetSlimWalkCallCount,
  runRetentionSweep,
} from "../src/runtime/runRetentionSweep.js";
import { worktreePathForRun } from "../src/runtime/repositoryMaterialize.js";

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

async function createSourceRepo(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-u6-src-"));
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

function setFinishedAt(
  db: Database.Database,
  runId: string,
  finishedAt: string,
): void {
  db.prepare(`UPDATE runs SET finished_at = ? WHERE run_id = ?`).run(
    finishedAt,
    runId,
  );
}

async function seedAttemptTree(
  workspaceDir: string,
  options?: { oversizedArtifactBytes?: number },
): Promise<{
  envelopePath: string;
  logPath: string;
  streamPath: string;
  sessionPath: string;
  agentDir: string;
  smallArtifact: string;
  oversizedArtifact: string;
  verificationOk: true;
}> {
  const attemptDir = path.join(
    workspaceDir,
    "stages",
    "build",
    "attempts",
    "1",
  );
  const artifactsDir = path.join(attemptDir, "artifacts");
  const agentDir = path.join(attemptDir, ".pi-agent");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const envelopePath = path.join(attemptDir, "envelope.json");
  const logPath = path.join(attemptDir, "log.jsonl");
  const streamPath = path.join(attemptDir, "stream.log");
  const sessionPath = path.join(attemptDir, "pi-session.jsonl");
  const smallArtifact = path.join(artifactsDir, "small.txt");
  const oversizedArtifact = path.join(artifactsDir, "huge.bin");

  await writeFile(
    envelopePath,
    JSON.stringify({ status: "success", summary: "ok", artifacts: [] }),
  );
  await writeFile(logPath, '{"event":"started"}\n');
  await writeFile(streamPath, "stream-bytes\n");
  await writeFile(sessionPath, "session-bytes\n");
  await writeFile(path.join(agentDir, "scratch.txt"), "agent-scratch\n");
  await writeFile(smallArtifact, "tiny\n");
  const oversized =
    options?.oversizedArtifactBytes ?? 1024 * 1024 + 64;
  await writeFile(oversizedArtifact, Buffer.alloc(oversized, 0xab));

  return {
    envelopePath,
    logPath,
    streamPath,
    sessionPath,
    agentDir,
    smallArtifact,
    oversizedArtifact,
    verificationOk: true,
  };
}

beforeEach(async () => {
  stashEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "STAGEFLOW_SLIM_SUCCEEDED_MS",
    "STAGEFLOW_PURGE_SUCCEEDED_MS",
    "STAGEFLOW_SLIM_FAILED_MS",
    "STAGEFLOW_PURGE_FAILED_MS",
    "STAGEFLOW_SLIM_CANCELLED_MS",
    "STAGEFLOW_PURGE_CANCELLED_MS",
    "STAGEFLOW_BARE_CACHE_TTL_MS",
    "STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES",
  ]);
  resetGlobalStageflowHomeForTests();
  resetBareCacheStateForTests();
  setBareCacheRemoteUrlOverrideForTests(null);
  resetSlimWalkCallCount();
  const home = await mkdtemp(path.join(tmpdir(), "sf-u6-home-"));
  temps.push(home);
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  process.env.GITHUB_TOKEN = "ghp_TestTokenForU6XXXXXXXXXXXXXXX";
});

afterEach(async () => {
  setBareCacheRemoteUrlOverrideForTests(null);
  resetBareCacheStateForTests();
  restoreEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "STAGEFLOW_SLIM_SUCCEEDED_MS",
    "STAGEFLOW_PURGE_SUCCEEDED_MS",
    "STAGEFLOW_SLIM_FAILED_MS",
    "STAGEFLOW_PURGE_FAILED_MS",
    "STAGEFLOW_SLIM_CANCELLED_MS",
    "STAGEFLOW_PURGE_CANCELLED_MS",
    "STAGEFLOW_BARE_CACHE_TTL_MS",
    "STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES",
  ]);
  resetGlobalStageflowHomeForTests();
  resetSlimWalkCallCount();
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("retentionDecision (KD1 table-driven)", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");
  const windows = DEFAULT_RETENTION_WINDOWS;

  it.each([
    {
      name: "succeeded past SLIM not PURGE → slim",
      status: "succeeded" as const,
      ageMs: 4 * DAY_MS,
      slimmed_at: undefined,
      expected: "slim" as const,
    },
    {
      name: "succeeded before SLIM → none",
      status: "succeeded" as const,
      ageMs: 2 * DAY_MS,
      slimmed_at: undefined,
      expected: "none" as const,
    },
    {
      name: "succeeded past PURGE → purge",
      status: "succeeded" as const,
      ageMs: 31 * DAY_MS,
      slimmed_at: undefined,
      expected: "purge" as const,
    },
    {
      name: "succeeded already slimmed before PURGE → none",
      status: "succeeded" as const,
      ageMs: 4 * DAY_MS,
      slimmed_at: "2026-09-20T00:00:00.000Z",
      expected: "none" as const,
    },
    {
      name: "failed at succeeded-SLIM age → none",
      status: "failed" as const,
      ageMs: 4 * DAY_MS,
      slimmed_at: undefined,
      expected: "none" as const,
    },
    {
      name: "failed past failed-SLIM → slim",
      status: "failed" as const,
      ageMs: 31 * DAY_MS,
      slimmed_at: undefined,
      expected: "slim" as const,
    },
    {
      name: "cancelled before 30d SLIM → none",
      status: "cancelled" as const,
      ageMs: 2 * DAY_MS,
      slimmed_at: undefined,
      expected: "none" as const,
    },
    {
      name: "cancelled past 30d SLIM → slim",
      status: "cancelled" as const,
      ageMs: 31 * DAY_MS,
      slimmed_at: undefined,
      expected: "slim" as const,
    },
    {
      name: "running never eligible",
      status: "running" as const,
      ageMs: 400 * DAY_MS,
      slimmed_at: undefined,
      expected: "none" as const,
    },
  ])("$name", ({ status, ageMs, slimmed_at, expected }) => {
    const finished_at = new Date(now.getTime() - ageMs).toISOString();
    expect(
      retentionDecision({ status, finished_at, slimmed_at }, now, windows),
    ).toBe(expected);
  });

  it("defaults failed and cancelled SLIM to 30d; succeeded stays 3d", () => {
    expect(DEFAULT_RETENTION_WINDOWS.failed.slimMs).toBe(30 * DAY_MS);
    expect(DEFAULT_RETENTION_WINDOWS.cancelled.slimMs).toBe(30 * DAY_MS);
    expect(DEFAULT_RETENTION_WINDOWS.succeeded.slimMs).toBe(3 * DAY_MS);
    expect(DEFAULT_RETENTION_WINDOWS.failed.purgeMs).toBe(90 * DAY_MS);
    expect(DEFAULT_RETENTION_WINDOWS.cancelled.purgeMs).toBe(90 * DAY_MS);
  });

  it("reads finished_at only — updated_at is irrelevant (KTD1)", () => {
    const finished_at = new Date(now.getTime() - 4 * DAY_MS).toISOString();
    expect(
      retentionDecision(
        { status: "succeeded", finished_at, slimmed_at: undefined },
        now,
        windows,
      ),
    ).toBe("slim");
  });

  it("applies per-status env overrides", () => {
    const envWindows = retentionWindowsFromEnv({
      STAGEFLOW_SLIM_SUCCEEDED_MS: String(10 * DAY_MS),
      STAGEFLOW_PURGE_FAILED_MS: String(5 * DAY_MS),
    });
    expect(envWindows.succeeded.slimMs).toBe(10 * DAY_MS);
    expect(envWindows.failed.purgeMs).toBe(5 * DAY_MS);
    expect(envWindows.cancelled).toEqual(DEFAULT_RETENTION_WINDOWS.cancelled);
  });
});

describe("run retention fixtures (U1 columns)", () => {
  it("exposes finished_at and slimmed_at for later retention decisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retention-fixture-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");

    const meta = await store.readRunMeta(run.runId);
    expect(meta.finished_at).toBeDefined();
    expect(meta.slimmed_at).toBeUndefined();

    const db = new Database(path.join(storeRootFor(root), "state.db"));
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const name of [
      "cancel_reason",
      "finished_at",
      "slimmed_at",
      "disk_bytes",
      "disk_measured_at",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
    db.close();
  });
});

describe("runRetentionSweep (U6)", () => {
  it("SLIMs a succeeded run past SLIM but not PURGE; keeps envelope and DB rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-slim-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.createStageExecution(run.runId, "build");
    await store.upsertVerificationCheckResult(run.runId, "build", {
      check_id: "c1",
      check_type: "command",
      status: "passed",
    });
    await store.writeEnvelope(run.runId, "build", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    await store.updateRunStatus(run.runId, "succeeded");
    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    );

    const workspaceDir = store.getWorkspaceDir(run.runId);
    const tree = await seedAttemptTree(workspaceDir);

    let checkoutRoot: string | undefined;
    let cachePath: string | undefined;
    let runBranch: string | undefined;
    if (gitAvailable) {
      const { root: source, sha } = await createSourceRepo();
      setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);
      const repository = "acme/u6-slim";
      runBranch = `stageflow/run-${run.runId}`;
      checkoutRoot = worktreePathForRun(run.runId);
      const ensured = await ensureBareCache(repository, "main");
      cachePath = ensured.cachePath;
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
    }

    const report = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
    });
    expect(report.slimmed).toEqual([run.runId]);
    expect(report.purged).toEqual([]);

    expect(existsSync(tree.envelopePath)).toBe(true);
    expect(existsSync(tree.logPath)).toBe(true);
    expect(existsSync(tree.smallArtifact)).toBe(true);
    expect(existsSync(tree.streamPath)).toBe(false);
    expect(existsSync(tree.sessionPath)).toBe(false);
    expect(existsSync(tree.agentDir)).toBe(false);
    expect(existsSync(tree.oversizedArtifact)).toBe(false);

    const envelope = await store.readEnvelope(run.runId, "build");
    expect(envelope?.summary).toBe("ok");
    const meta = await store.readRunMeta(run.runId);
    expect(meta.status).toBe("succeeded");
    expect(meta.slimmed_at).toBeDefined();
    expect(meta.checkout_root).toBe(checkoutRoot);
    expect(meta.repository).toBe(gitAvailable ? "acme/u6-slim" : undefined);
    expect(meta.run_branch).toBe(runBranch);
    expect(
      (
        connection
          .prepare(
            `SELECT COUNT(*) AS n FROM stage_events WHERE run_id = ?`,
          )
          .get(run.runId) as { n: number }
      ).n,
    ).toBeGreaterThan(0);
    expect(
      (
        connection
          .prepare(
            `SELECT COUNT(*) AS n FROM verification_check_results WHERE run_id = ?`,
          )
          .get(run.runId) as { n: number }
      ).n,
    ).toBeGreaterThan(0);

    if (gitAvailable && checkoutRoot && cachePath && runBranch) {
      expect(existsSync(checkoutRoot)).toBe(false);
      expect(git(cachePath, ["branch", "--list", runBranch])).toContain(
        runBranch,
      );
    }
  });

  it("PURGEs a run past its PURGE window like delete_run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-purge-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "succeeded");
    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 31 * DAY_MS).toISOString(),
    );
    const workspaceDir = store.getWorkspaceDir(run.runId);
    await seedAttemptTree(workspaceDir);

    const report = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
    });
    expect(report.purged).toEqual([run.runId]);
    expect(report.slimmed).toEqual([]);
    expect(existsSync(workspaceDir)).toBe(false);
    await expect(store.readRun(run.runId)).rejects.toThrow(/Run not found/);
  });

  it("failed vs succeeded with the same finished_at SLIM on different days", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-windows-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");
    const finishedAt = new Date(now.getTime() - 5 * DAY_MS).toISOString();

    const ok = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: ok\ngoal: g\n",
    });
    await store.updateRunStatus(ok.runId, "succeeded");
    setFinishedAt(connection, ok.runId, finishedAt);

    const bad = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: bad\ngoal: g\n",
    });
    await store.updateRunStatus(bad.runId, "failed");
    setFinishedAt(connection, bad.runId, finishedAt);

    const dry = await runRetentionSweep(store, a2aStore, {
      now,
      execute: false,
    });
    expect(dry.slimmed).toEqual([ok.runId]);
    expect(dry.slimmed).not.toContain(bad.runId);
    expect(dry.purged).toEqual([]);
  });

  it("leaves non-terminal runs untouched even when ancient", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-running-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 400 * DAY_MS).toISOString(),
    );
    const workspaceDir = store.getWorkspaceDir(run.runId);
    const tree = await seedAttemptTree(workspaceDir);

    const report = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
    });
    expect(report.slimmed).toEqual([]);
    expect(report.purged).toEqual([]);
    expect(existsSync(tree.streamPath)).toBe(true);
    expect(existsSync(tree.agentDir)).toBe(true);
    const meta = await store.readRunMeta(run.runId);
    expect(meta.status).toBe("running");
    expect(meta.slimmed_at).toBeUndefined();
  });

  it("second sweep is a true no-op and does not re-walk slimmed trees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-idem-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");
    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    );
    await seedAttemptTree(store.getWorkspaceDir(run.runId));

    resetSlimWalkCallCount();
    const first = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
    });
    expect(first.slimmed).toEqual([run.runId]);
    const walksAfterFirst = getSlimWalkCallCount();
    expect(walksAfterFirst).toBeGreaterThan(0);

    const second = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
    });
    expect(second.slimmed).toEqual([]);
    expect(second.purged).toEqual([]);
    expect(getSlimWalkCallCount()).toBe(walksAfterFirst);
  });

  it("dry-run reports the same candidates without mutating", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-dry-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");
    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    );
    const tree = await seedAttemptTree(store.getWorkspaceDir(run.runId));

    const dry = await runRetentionSweep(store, a2aStore, {
      now,
      execute: false,
    });
    expect(dry.slimmed).toEqual([run.runId]);
    expect(existsSync(tree.streamPath)).toBe(true);
    const meta = await store.readRunMeta(run.runId);
    expect(meta.slimmed_at).toBeUndefined();
  });

  it("anti: envelope.json survives SLIM under overridden windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-anti-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");
    const windows: RetentionWindows = {
      succeeded: { slimMs: 0, purgeMs: 90 * DAY_MS },
      failed: DEFAULT_RETENTION_WINDOWS.failed,
      cancelled: DEFAULT_RETENTION_WINDOWS.cancelled,
    };

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");
    setFinishedAt(connection, run.runId, now.toISOString());
    const tree = await seedAttemptTree(store.getWorkspaceDir(run.runId));

    await runRetentionSweep(store, a2aStore, { now, execute: true, windows });
    expect(existsSync(tree.envelopePath)).toBe(true);
    expect(JSON.parse(await readFile(tree.envelopePath, "utf8")).summary).toBe(
      "ok",
    );
  });
});

describe.skipIf(!gitAvailable)("bare-cache eviction (U6)", () => {
  it("never evicts a bare cache with a live worktree; evicts when all terminal and old", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-bare-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");
    const { root: source, sha } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);
    const repository = "acme/u6-bare";
    // failed: SLIM 30d / PURGE 90d — 10d-old stays unreclaimed so the worktree can stay live.
    const finishedAt = new Date(now.getTime() - 10 * DAY_MS).toISOString();
    const bareTtlMs = 7 * DAY_MS;

    const live = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: live\ngoal: g\n",
    });
    await store.updateRunStatus(live.runId, "failed");
    setFinishedAt(connection, live.runId, finishedAt);
    const liveCheckout = worktreePathForRun(live.runId);
    const liveBranch = `stageflow/run-${live.runId}`;
    const { cachePath } = await ensureBareCache(repository, "main");
    mkdirSync(path.dirname(liveCheckout), { recursive: true });
    await worktreeAdd(cachePath, {
      worktreePath: liveCheckout,
      branch: liveBranch,
      startPoint: sha,
    });
    connection
      .prepare(
        `UPDATE runs SET repository = ?, ref = ?, resolved_sha = ?, checkout_root = ?, run_branch = ? WHERE run_id = ?`,
      )
      .run(repository, "main", sha, liveCheckout, liveBranch, live.runId);

    const blocked = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
      bareCacheTtlMs: bareTtlMs,
    });
    expect(blocked.slimmed).toEqual([]);
    expect(blocked.purged).toEqual([]);
    expect(blocked.bareCachesEvicted).not.toContain(cachePath);
    expect(existsSync(cachePath)).toBe(true);
    expect(existsSync(liveCheckout)).toBe(true);

    await rm(liveCheckout, { recursive: true, force: true });
    try {
      git(cachePath, ["worktree", "prune"]);
    } catch {
      /* ignore */
    }

    const evicted = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
      bareCacheTtlMs: bareTtlMs,
    });
    expect(evicted.bareCachesEvicted).toContain(cachePath);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("anti: run branch survives SLIM", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-branch-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");
    const { root: source, sha } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");
    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    );
    await seedAttemptTree(store.getWorkspaceDir(run.runId));

    const repository = "acme/u6-branch";
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

    await runRetentionSweep(store, a2aStore, { now, execute: true });
    expect(existsSync(checkoutRoot)).toBe(false);
    expect(git(cachePath, ["branch", "--list", runBranch])).toContain(runBranch);
  });

  it("SLIM after succeed reclaim still sets slimmed_at (worktree step no-op)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u2-slim-after-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");
    const { root: source, sha } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const repository = "acme/u2-slim-after";
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

    const { writeTerminalRunStatus } = await import(
      "../src/runtime/pipelineScheduler.js"
    );
    await writeTerminalRunStatus(store, run.runId, "succeeded");
    expect(existsSync(checkoutRoot)).toBe(false);
    expect((await store.readRunMeta(run.runId)).slimmed_at).toBeUndefined();

    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    );
    await seedAttemptTree(store.getWorkspaceDir(run.runId));

    const report = await runRetentionSweep(store, a2aStore, {
      now,
      execute: true,
    });
    expect(report.slimmed).toEqual([run.runId]);
    const meta = await store.readRunMeta(run.runId);
    expect(meta.slimmed_at).toBeDefined();
    expect(meta.checkout_root).toBe(checkoutRoot);
    expect(git(cachePath, ["branch", "--list", runBranch])).toContain(runBranch);
  });

  it("refuses execute when a2aStore missing and PURGE candidates exist (before SLIM)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-no-a2a-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const now = new Date("2026-09-22T12:00:00.000Z");

    const slimTarget = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(slimTarget.runId, "succeeded");
    setFinishedAt(
      connection,
      slimTarget.runId,
      new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    );
    await seedAttemptTree(store.getWorkspaceDir(slimTarget.runId));

    const purgeTarget = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t2\ngoal: g\n",
    });
    await store.updateRunStatus(purgeTarget.runId, "succeeded");
    setFinishedAt(
      connection,
      purgeTarget.runId,
      new Date(now.getTime() - 400 * DAY_MS).toISOString(),
    );

    await expect(
      runRetentionSweep(store, undefined, { now, execute: true }),
    ).rejects.toThrow(/a2aStore is required/);

    const slimMeta = await store.readRunMeta(slimTarget.runId);
    expect(slimMeta.slimmed_at).toBeUndefined();
  });

  it("failed artifact slim does not set slimmed_at", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-u6-slim-fail-"));
    temps.push(root);
    const { store, connection } = createRunStoreWithConnection({ rootDir: root });
    const a2aStore = new A2aStore(root, connection);
    const now = new Date("2026-09-22T12:00:00.000Z");

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");
    setFinishedAt(
      connection,
      run.runId,
      new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    );
    await seedAttemptTree(store.getWorkspaceDir(run.runId));

    const materialize = await import("../src/runtime/repositoryMaterialize.js");
    const spy = vi
      .spyOn(materialize, "reclaimWorkspaceBinding")
      .mockRejectedValue(new Error("reclaim boom"));

    try {
      const report = await runRetentionSweep(store, a2aStore, {
        now,
        execute: true,
      });
      expect(report.slimmed).toEqual([]);
      const meta = await store.readRunMeta(run.runId);
      expect(meta.slimmed_at).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
