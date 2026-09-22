import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { runRunsCommand } from "../src/cli/runsCommand.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { DAY_MS } from "../src/runstore/retention.js";
import type { RunManager } from "../src/runtime/runManager.js";
import {
  gcIntervalMsFromEnv,
  startPeriodicRunGc,
  DEFAULT_GC_INTERVAL_MS,
} from "../src/server/bootstrap.js";
import { isMutatingApi, startUiServer } from "../src/server/http.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const fixtures = FIXTURES_ROOT;
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

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line: string) => {
        stdout.push(line);
      },
      error: (line: string) => {
        stderr.push(line);
      },
    },
  };
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

async function seedSlimTree(workspaceDir: string): Promise<string> {
  const attemptDir = path.join(
    workspaceDir,
    "stages",
    "build",
    "attempts",
    "1",
  );
  mkdirSync(attemptDir, { recursive: true });
  const streamPath = path.join(attemptDir, "stream.log");
  await writeFile(streamPath, "stream-bytes\n");
  await writeFile(
    path.join(attemptDir, "envelope.json"),
    JSON.stringify({ status: "success", summary: "ok", artifacts: [] }),
  );
  return streamPath;
}

async function withServer(root: string) {
  const { store, connection } = createRunStoreWithConnection({ rootDir: root });
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: fixtures,
    rootDir: root,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    mcpStateless: true,
  });
  const address = started.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    store,
    connection,
    server: started.server,
    base: `http://127.0.0.1:${address.port}`,
  };
}

beforeEach(async () => {
  stashEnv(["STAGEFLOW_HOME", "STAGEFLOW_GC_INTERVAL_MS"]);
  resetGlobalStageflowHomeForTests();
  const home = await mkdtemp(path.join(tmpdir(), "sf-cli-gc-home-"));
  temps.push(home);
  process.env.STAGEFLOW_HOME = home;
  process.env.STAGEFLOW_GC_INTERVAL_MS = "0";
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  restoreEnv(["STAGEFLOW_HOME", "STAGEFLOW_GC_INTERVAL_MS"]);
  resetGlobalStageflowHomeForTests();
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("isMutatingApi gc widening", () => {
  it("recognizes POST /api/runs/gc", () => {
    expect(isMutatingApi("POST", "/api/runs/gc")).toBe(true);
    expect(isMutatingApi("GET", "/api/runs/gc")).toBe(false);
    expect(isMutatingApi("DELETE", "/api/runs/abc-123")).toBe(true);
  });
});

describe("sf runs gc", () => {
  it("dry-run reports the same candidates a mutating gc reclaims and changes nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-gc-"));
    temps.push(root);
    const { store, connection, server, base } = await withServer(root);
    try {
      const planted = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.updateRunStatus(planted.runId, "succeeded");
      const now = new Date("2026-09-22T12:00:00.000Z");
      setFinishedAt(
        connection,
        planted.runId,
        new Date(now.getTime() - 4 * DAY_MS).toISOString(),
      );
      const streamPath = await seedSlimTree(store.getWorkspaceDir(planted.runId));

      // Freeze Host clock by patching Date only around the GC calls via env windows:
      // finished_at is already 4d ago vs default 3d SLIM window.
      const ensureService = async () =>
        ({ ok: true as const, alreadyRunning: true as const });

      const dryCap = captureIo();
      const dryCode = await runRunsCommand(["gc", "--dry-run", "--json"], {
        cwd: fixtures,
        hostBaseUrl: base,
        ensureService,
        io: dryCap.io,
      });
      expect(dryCode).toBe(0);
      const dryReport = JSON.parse(dryCap.stdout.join("\n")) as {
        slimmed: string[];
        purged: string[];
        bareCachesEvicted: string[];
      };
      expect(dryReport.slimmed).toEqual([planted.runId]);
      expect(dryReport.purged).toEqual([]);
      expect(existsSync(streamPath)).toBe(true);
      const afterDry = await store.readRunMeta(planted.runId);
      expect(afterDry.slimmed_at).toBeUndefined();

      const mutCap = captureIo();
      const mutCode = await runRunsCommand(["gc", "--json"], {
        cwd: fixtures,
        hostBaseUrl: base,
        ensureService,
        io: mutCap.io,
      });
      expect(mutCode).toBe(0);
      const mutReport = JSON.parse(mutCap.stdout.join("\n")) as {
        slimmed: string[];
        purged: string[];
        bareCachesEvicted: string[];
      };
      expect(mutReport.slimmed).toEqual(dryReport.slimmed);
      expect(mutReport.purged).toEqual(dryReport.purged);
      expect(mutReport.bareCachesEvicted).toEqual(dryReport.bareCachesEvicted);
      expect(existsSync(streamPath)).toBe(false);
      const afterMut = await store.readRunMeta(planted.runId);
      expect(afterMut.slimmed_at).toBeDefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("REST POST /api/runs/gc returns the same report shape as CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rest-gc-"));
    temps.push(root);
    const { store, connection, server, base } = await withServer(root);
    try {
      const planted = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.updateRunStatus(planted.runId, "succeeded");
      setFinishedAt(
        connection,
        planted.runId,
        new Date(Date.now() - 4 * DAY_MS).toISOString(),
      );

      const rest = await fetch(`${base}/api/runs/gc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(rest.status).toBe(200);
      const restBody = await rest.json();
      expect(restBody).toEqual({
        slimmed: [planted.runId],
        purged: [],
        bareCachesEvicted: [],
      });

      const cap = captureIo();
      const code = await runRunsCommand(["gc", "--dry-run", "--json"], {
        cwd: fixtures,
        hostBaseUrl: base,
        ensureService: async () =>
          ({ ok: true as const, alreadyRunning: true as const }),
        io: cap.io,
      });
      expect(code).toBe(0);
      expect(JSON.parse(cap.stdout.join("\n"))).toEqual(restBody);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("periodic GC timer", () => {
  it("STAGEFLOW_GC_INTERVAL_MS=0 disables the timer", () => {
    expect(gcIntervalMsFromEnv({ STAGEFLOW_GC_INTERVAL_MS: "0" })).toBe(0);
    expect(gcIntervalMsFromEnv({})).toBe(DEFAULT_GC_INTERVAL_MS);
    const manager = {
      gcRuns: vi.fn(async () => ({
        ok: true as const,
        slimmed: [],
        purged: [],
        bareCachesEvicted: [],
      })),
    } as unknown as RunManager;
    expect(startPeriodicRunGc(manager, 0)).toBeUndefined();
  });

  it("registers an unref'd interval so the process can exit", () => {
    const manager = {
      gcRuns: vi.fn(async () => ({
        ok: true as const,
        slimmed: [],
        purged: [],
        bareCachesEvicted: [],
      })),
    } as unknown as RunManager;
    const handle = startPeriodicRunGc(manager, 60_000);
    expect(handle).toBeDefined();
    expect(handle!.hasRef()).toBe(false);
    clearInterval(handle!);
  });

  it("skips overlapping ticks while a sweep is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gcRuns = vi.fn(async () => {
      await gate;
      return {
        ok: true as const,
        slimmed: [],
        purged: [],
        bareCachesEvicted: [],
      };
    });
    const manager = { gcRuns } as unknown as RunManager;
    const handle = startPeriodicRunGc(manager, 20);
    await new Promise((r) => setTimeout(r, 35));
    expect(gcRuns).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(gcRuns).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect(gcRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    clearInterval(handle!);
  });
});
