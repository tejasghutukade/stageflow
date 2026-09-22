import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  DISK_WARN_LOG_PREFIX,
  diskUsageOf,
  durableRootDiskBreakdown,
  getDiskUsageWalkCallCount,
  refreshRunDiskUsage,
  resetDiskUsageWalkCallCount,
  setFreeSpaceReaderForTests,
  warnDurableRootDiskIfNeeded,
} from "../src/runstore/diskUsage.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import {
  resetGlobalStageflowHomeForTests,
} from "../src/project/globalHome.js";

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

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  setFreeSpaceReaderForTests(null);
  resetDiskUsageWalkCallCount();
  resetGlobalStageflowHomeForTests();
  restoreEnv(["STAGEFLOW_HOME", "STAGEFLOW_DISK_WARN_BYTES", "HOME"]);
  while (temps.length > 0) {
    temps.pop();
  }
});

describe("diskUsageOf", () => {
  it("sums blocks*512 for attempt-scoped and legacy artifact shapes", async () => {
    const root = await tempDir("sf-disk-tree-");
    const attemptArt = path.join(
      root,
      "stages",
      "plan",
      "attempts",
      "1",
      "artifacts",
    );
    const legacyArt = path.join(root, "stages", "plan", "artifacts");
    await mkdir(attemptArt, { recursive: true });
    await mkdir(legacyArt, { recursive: true });
    await writeFile(path.join(attemptArt, "notes.md"), "attempt-notes\n");
    await writeFile(path.join(legacyArt, "legacy.md"), "legacy-notes\n");
    await writeFile(path.join(root, "stages", "plan", "envelope.json"), "{}");

    const bytes = await diskUsageOf(root);
    expect(bytes).toBeGreaterThan(0);

    const attemptOnly = await diskUsageOf(attemptArt);
    const legacyOnly = await diskUsageOf(legacyArt);
    expect(attemptOnly).toBeGreaterThan(0);
    expect(legacyOnly).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThanOrEqual(attemptOnly + legacyOnly);
  });

  it("returns 0 for a missing path", async () => {
    expect(await diskUsageOf(path.join(tmpdir(), "sf-missing-disk-" + Date.now()))).toBe(
      0,
    );
  });
});

describe("durableRootDiskBreakdown + GET /api/health", () => {
  it("reports non-negative category bytes and free space", async () => {
    const home = await tempDir("sf-disk-home-");
    stashEnv(["STAGEFLOW_HOME", "HOME"]);
    process.env.HOME = home;
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();

    await mkdir(path.join(home, "runs", "r1"), { recursive: true });
    await writeFile(path.join(home, "runs", "r1", "marker.txt"), "run\n");
    await mkdir(path.join(home, "worktrees", "r1"), { recursive: true });
    await writeFile(path.join(home, "worktrees", "r1", "w.txt"), "wt\n");
    await mkdir(path.join(home, "repos", "github.com", "o", "r.git"), {
      recursive: true,
    });
    await writeFile(
      path.join(home, "repos", "github.com", "o", "r.git", "HEAD"),
      "ref\n",
    );
    await mkdir(path.join(home, "a2a-artifacts"), { recursive: true });
    await writeFile(path.join(home, "a2a-artifacts", "a.bin"), "aa");

    const breakdown = await durableRootDiskBreakdown(home);
    expect(breakdown.runs_bytes).toBeGreaterThanOrEqual(0);
    expect(breakdown.worktrees_bytes).toBeGreaterThanOrEqual(0);
    expect(breakdown.repos_bytes).toBeGreaterThanOrEqual(0);
    expect(breakdown.state_db_bytes).toBeGreaterThanOrEqual(0);
    expect(breakdown.a2a_artifacts_bytes).toBeGreaterThanOrEqual(0);
    expect(breakdown.free_bytes).toBeGreaterThanOrEqual(0);
    expect(breakdown.runs_bytes).toBeGreaterThan(0);
    expect(breakdown.worktrees_bytes).toBeGreaterThan(0);

    const store = createRunStore({ rootDir: home, openerMode: "migrate" });
    const afterStore = await durableRootDiskBreakdown(home);
    expect(afterStore.state_db_bytes).toBeGreaterThan(0);
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: home,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      maxConcurrent: 1,
    });
    try {
      const addr = started.server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("expected TCP address");
      }
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: true;
        disk: {
          runs_bytes: number;
          worktrees_bytes: number;
          repos_bytes: number;
          state_db_bytes: number;
          a2a_artifacts_bytes: number;
          free_bytes: number;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.disk.runs_bytes).toBeGreaterThanOrEqual(0);
      expect(body.disk.worktrees_bytes).toBeGreaterThanOrEqual(0);
      expect(body.disk.repos_bytes).toBeGreaterThanOrEqual(0);
      expect(body.disk.state_db_bytes).toBeGreaterThanOrEqual(0);
      expect(body.disk.a2a_artifacts_bytes).toBeGreaterThanOrEqual(0);
      expect(body.disk.free_bytes).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("STAGEFLOW_DISK_WARN_BYTES boot warning", () => {
  it("unset → no warning, no throw", async () => {
    const home = await tempDir("sf-disk-warn-off-");
    stashEnv(["STAGEFLOW_DISK_WARN_BYTES"]);
    delete process.env.STAGEFLOW_DISK_WARN_BYTES;
    const log = vi.fn();
    const warned = await warnDurableRootDiskIfNeeded(home, {
      env: {},
      freeSpace: async () => ({ freeBytes: 100, totalBytes: 1000 }),
      log,
    });
    expect(warned).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("crossing threshold → exactly one warning; boot still completes", async () => {
    const home = await tempDir("sf-disk-warn-on-");
    stashEnv(["STAGEFLOW_HOME", "HOME", "STAGEFLOW_DISK_WARN_BYTES"]);
    process.env.HOME = home;
    process.env.STAGEFLOW_HOME = home;
    process.env.STAGEFLOW_DISK_WARN_BYTES = "500";
    resetGlobalStageflowHomeForTests();

    const log = vi.fn();
    setFreeSpaceReaderForTests(async () => ({
      freeBytes: 100,
      totalBytes: 10_000,
    }));

    const warned = await warnDurableRootDiskIfNeeded(home, {
      env: process.env,
      log,
    });
    expect(warned).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain(DISK_WARN_LOG_PREFIX);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const boot = await bootstrapStageflowHost({
        agent: scriptedFakeAgent([]),
        cwd: home,
        rootDir: home,
        maxConcurrent: 1,
      });
      expect(boot.manager).toBeDefined();
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes(DISK_WARN_LOG_PREFIX))).toBe(
        true,
      );
      expect(
        warnSpy.mock.calls.filter((c) =>
          String(c[0]).includes(DISK_WARN_LOG_PREFIX),
        ),
      ).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("listRuns never walks disk per row (KTD16)", () => {
  it("returns cached disk_bytes without invoking the walker", async () => {
    const root = await tempDir("sf-disk-list-");
    const store = createRunStore({ rootDir: root, openerMode: "migrate" });
    const run = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    await mkdir(path.join(run.workspaceDir, "stages", "a", "artifacts"), {
      recursive: true,
    });
    await writeFile(
      path.join(run.workspaceDir, "stages", "a", "artifacts", "x.txt"),
      "hello",
    );

    const measured = await refreshRunDiskUsage(store, run.runId, {
      now: new Date("2026-09-22T12:00:00.000Z"),
    });
    expect(measured).toBeGreaterThan(0);

    resetDiskUsageWalkCallCount();
    const before = getDiskUsageWalkCallCount();
    expect(before).toBe(0);

    const listed = await store.listRuns();
    expect(getDiskUsageWalkCallCount()).toBe(0);

    const row = listed.find((r) => r.run_id === run.runId);
    expect(row?.disk_bytes).toBe(measured);
    expect(row?.disk_measured_at).toBe("2026-09-22T12:00:00.000Z");

    const meta = await store.readRunMeta(run.runId);
    expect(meta.disk_bytes).toBe(measured);
  });
});
