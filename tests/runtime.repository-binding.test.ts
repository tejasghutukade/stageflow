import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import {
  bareCachePath,
  resetBareCacheStateForTests,
  setBareCacheRemoteUrlOverrideForTests,
} from "../src/git/cache.js";
import { runGitSync } from "../src/git/exec.js";
import { worktreePathForRun } from "../src/runtime/repositoryMaterialize.js";
import { RunManager } from "../src/runtime/runManager.js";
import {
  resetGlobalStageflowHomeForTests,
} from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

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
  const root = await mkdtemp(path.join(tmpdir(), "sf-u5-src-"));
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

function gatedAgent(gate: Promise<void>) {
  return {
    openStage(input: { stage: { id: string } }) {
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => {
          await gate;
          return {
            ok: true as const,
            envelope: {
              status: "success" as const,
              summary: "ok",
              artifacts: [],
              payload: {},
            },
          };
        },
      });
    },
    async runStage() {
      await gate;
      return {
        ok: true as const,
        envelope: {
          status: "success" as const,
          summary: "ok",
          artifacts: [],
          payload: {},
        },
      };
    },
  };
}

function fastAgent() {
  return {
    openStage(input: { stage: { id: string } }) {
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => ({
          ok: true as const,
          envelope: {
            status: "success" as const,
            summary: "ok",
            artifacts: [],
            payload: {},
          },
        }),
      });
    },
    async runStage() {
      return {
        ok: true as const,
        envelope: {
          status: "success" as const,
          summary: "ok",
          artifacts: [],
          payload: {},
        },
      };
    },
  };
}

async function waitUntilIdle(manager: RunManager): Promise<void> {
  while (manager.getActiveCount() > 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function worktreeList(cachePath: string): string {
  try {
    return execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: cachePath,
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

beforeEach(async () => {
  stashEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "STAGEFLOW_RUN_BRANCH_TEMPLATE",
  ]);
  resetGlobalStageflowHomeForTests();
  resetBareCacheStateForTests();
  setBareCacheRemoteUrlOverrideForTests(null);
  const home = await mkdtemp(path.join(tmpdir(), "sf-u5-home-"));
  temps.push(home);
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  process.env.GITHUB_TOKEN = "ghp_TestTokenForU5XXXXXXXXXXXXXXX";
});

afterEach(async () => {
  setBareCacheRemoteUrlOverrideForTests(null);
  resetBareCacheStateForTests();
  restoreEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "STAGEFLOW_RUN_BRANCH_TEMPLATE",
  ]);
  resetGlobalStageflowHomeForTests();
  vi.restoreAllMocks();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(!gitAvailable)("repository binding start (U5)", () => {
  it("records repository binding and materializes a worktree before the run row", async () => {
    const { root: source, sha } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u5-store-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const manager = new RunManager({
      agent: fastAgent(),
      cwd: fixtures,
      store,
      maxConcurrent: 3,
    });

    const result = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: {
        id: "repo-task",
        goal: "work on repo",
        repository: "acme/api",
        ref: "main",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = await store.readRunMeta(result.runId);
    expect(meta.repository).toBe("acme/api");
    expect(meta.ref).toBe("main");
    expect(meta.resolved_sha).toBe(sha);
    expect(meta.run_branch).toBe(`stageflow/run-${result.runId}`);
    expect(meta.checkout_root).toBe(worktreePathForRun(result.runId));
    expect(existsSync(meta.checkout_root!)).toBe(true);
    expect(git(meta.checkout_root!, ["rev-parse", "HEAD"])).toBe(sha);
    expect(git(meta.checkout_root!, ["branch", "--show-current"])).toBe(
      `stageflow/run-${result.runId}`,
    );

    await result.done;
    await waitUntilIdle(manager);
  });

  it("allows parallel repository runs and still conflicts path peers", async () => {
    const { root: source } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u5-par-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 4,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: {
        id: "r1",
        goal: "one",
        repository: "acme/api",
        ref: "main",
      },
    });
    const second = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: {
        id: "r2",
        goal: "two",
        repository: "acme/api",
        ref: "main",
      },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.runId).not.toBe(second.runId);
    expect(manager.getActiveCount()).toBe(2);

    const checkout = await mkdtemp(path.join(tmpdir(), "sf-u5-path-"));
    temps.push(checkout);
    const pathFirst = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "p1", goal: "path-a", checkout },
    });
    expect(pathFirst.ok).toBe(true);
    if (!pathFirst.ok) return;

    const pathSecond = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "p2", goal: "path-b", checkout },
    });
    expect(pathSecond.ok).toBe(false);
    if (!pathSecond.ok) {
      expect(pathSecond.code).toBe("busy_checkout");
      expect(pathSecond.status).toBe(409);
    }

    release();
    await waitUntilIdle(manager);
  });

  it("maps ref_not_found without creating a run row or orphan worktree", async () => {
    const { root: source } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u5-ref-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const manager = new RunManager({
      agent: fastAgent(),
      cwd: fixtures,
      store,
    });

    const result = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: {
        id: "missing-ref",
        goal: "bad ref",
        repository: "acme/api",
        ref: "no-such-branch",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ref_not_found");
      expect(result.status).toBe(404);
    }

    const runs = await store.listRuns();
    expect(runs).toHaveLength(0);
    const cache = bareCachePath("acme/api");
    expect(worktreeList(cache)).not.toMatch(/worktrees\//);
    const worktreesRoot = path.join(process.env.STAGEFLOW_HOME!, "worktrees");
    if (existsSync(worktreesRoot)) {
      const entries = await readdir(worktreesRoot);
      expect(entries).toEqual([]);
    }
  });

  it("rolls back the worktree when createRun fails after worktreeAdd", async () => {
    const { root: source } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u5-rb-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const createRun = store.createRun.bind(store);
    store.createRun = async (input) => {
      if (input.repository === "acme/api") {
        throw new Error("injected createRun failure");
      }
      return createRun(input);
    };

    const manager = new RunManager({
      agent: fastAgent(),
      cwd: fixtures,
      store,
    });

    const result = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: {
        id: "rollback",
        goal: "fail create",
        repository: "acme/api",
        ref: "main",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/injected createRun failure/);
    }

    const runs = await store.listRuns();
    expect(runs).toHaveLength(0);
    const cache = bareCachePath("acme/api");
    expect(worktreeList(cache)).not.toMatch(/worktrees\//);
    expect(manager.getActiveCount()).toBe(0);
  });

  it("attach/resume of a repository run does not take a checkout lease", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u5-attach-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });

    const leasedPath = worktreePathForRun("attach-repo-run");
    mkdirSync(leasedPath, { recursive: true });

    const created = await store.createRun({
      pipelineId: "docs-only",
      pipelinePath: pipelinePath("docs-only"),
      projectRoot: fixtures,
      taskYaml: "id: wait\ngoal: wait\nrepository: acme/api\nref: main\n",
      taskId: "wait",
      repository: "acme/api",
      ref: "main",
      resolvedSha: "a".repeat(40),
      runBranch: "stageflow/run-test",
      checkoutRoot: leasedPath,
    });
    await store.updateRunStatus(created.runId, "running");
    await store.appendStageEvent(created.runId, "clarify", { event: "started" });
    await store.appendStageEvent(created.runId, "clarify", {
      event: "waiting_for_input",
      prompt: "need input",
    });

    const manager = new RunManager({
      agent: fastAgent(),
      cwd: fixtures,
      store,
      maxConcurrent: 3,
    });

    const attached = await manager.attachWaitingStages();
    expect(attached.some((a) => a.runId === created.runId)).toBe(true);

    // Under pre-U5 rules, attach would lease checkout_root and this path start would
    // return busy_checkout. Derived repository kind must not lease.
    const pathPeer = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "path-peer", goal: "peer path", checkout: leasedPath },
    });
    expect(pathPeer.ok).toBe(true);
    if (!pathPeer.ok) return;
    await pathPeer.done;
    // Attached repository run remains active without a checkout lease; path peer finished.
    expect(manager.getActiveCount()).toBeGreaterThanOrEqual(1);
    expect(manager.getActiveRunIds()).toContain(created.runId);
  });

  it("default rerun re-resolves ref tip; pinned missing SHA fails without fetch-by-sha", async () => {
    const { root: source, sha: firstSha } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u5-rerun-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const manager = new RunManager({
      agent: fastAgent(),
      cwd: fixtures,
      store,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: {
        id: "rerun-tip",
        goal: "tip",
        repository: "acme/api",
        ref: "main",
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.done;
    await waitUntilIdle(manager);
    const firstMeta = await store.readRunMeta(first.runId);
    expect(firstMeta.resolved_sha).toBe(firstSha);

    await writeFile(path.join(source, "README"), "moved tip\n");
    git(source, ["add", "README"]);
    git(source, ["commit", "-m", "move tip"]);
    const tipSha = git(source, ["rev-parse", "HEAD"]);
    expect(tipSha).not.toBe(firstSha);

    const tipRerun = await manager.rerun(first.runId);
    expect(tipRerun.ok).toBe(true);
    if (!tipRerun.ok) return;
    const tipMeta = await store.readRunMeta(tipRerun.runId);
    expect(tipMeta.ref).toBe("main");
    expect(tipMeta.resolved_sha).toBe(tipSha);
    await tipRerun.done;
    await waitUntilIdle(manager);

    const pinnedOk = await manager.rerun(first.runId, { pinned: true });
    expect(pinnedOk.ok).toBe(true);
    if (!pinnedOk.ok) return;
    const pinnedMeta = await store.readRunMeta(pinnedOk.runId);
    expect(pinnedMeta.ref).toBe("main");
    expect(pinnedMeta.resolved_sha).toBe(firstSha);
    await pinnedOk.done;
    await waitUntilIdle(manager);

    const ghost = await store.createRun({
      pipelineId: "docs-only",
      pipelinePath: pipelinePath("docs-only"),
      projectRoot: fixtures,
      taskYaml: "id: ghost\ngoal: ghost\nrepository: acme/api\nref: main\n",
      taskId: "ghost",
      repository: "acme/api",
      ref: "main",
      resolvedSha: "b".repeat(40),
      runBranch: "stageflow/run-ghost",
      checkoutRoot: worktreePathForRun("ghost"),
    });

    const pinnedMiss = await manager.rerun(ghost.runId, { pinned: true });
    expect(pinnedMiss.ok).toBe(false);
    if (!pinnedMiss.ok) {
      expect(pinnedMiss.code).toBe("pinned_sha_unavailable");
      expect(pinnedMiss.status).toBe(404);
    }
    const runs = await store.listRuns();
    expect(runs.filter((r) => r.binding.kind === "repository").length).toBeGreaterThanOrEqual(1);
    // No new run was created for the failed pinned start
    expect(runs.some((r) => r.run_id !== ghost.runId && r.binding.resolved_sha === "b".repeat(40))).toBe(
      false,
    );
  });

  it("path checkout records HEAD into resolved_sha when the path is a git repo", async () => {
    const { root: checkout, sha } = await createSourceRepo();
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u5-path-sha-"));
    temps.push(storeRoot);
    const store = createRunStore({ rootDir: storeRoot });
    const manager = new RunManager({
      agent: fastAgent(),
      cwd: fixtures,
      store,
    });

    const result = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "path-git", goal: "path", checkout },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = await store.readRunMeta(result.runId);
    expect(meta.resolved_sha).toBe(sha);
    expect(meta.repository).toBeUndefined();
    await result.done;
    await waitUntilIdle(manager);
  });
});
