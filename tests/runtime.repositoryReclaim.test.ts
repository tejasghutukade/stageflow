import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureBareCache,
  resetBareCacheStateForTests,
  setBareCacheRemoteUrlOverrideForTests,
} from "../src/git/cache.js";
import { runGitSync } from "../src/git/exec.js";
import * as operations from "../src/git/operations.js";
import { worktreeAdd } from "../src/git/operations.js";
import { writeTerminalRunStatus } from "../src/runtime/pipelineScheduler.js";
import {
  reclaimWorkspaceBinding,
  reclaimWorkspaceOnRunSucceeded,
  worktreePathForRun,
} from "../src/runtime/repositoryMaterialize.js";
import { syncRunStatusFromStages } from "../src/runtime/stageRecovery.js";
import {
  resetGlobalStageflowHomeForTests,
} from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunMeta } from "../src/runstore/port.js";

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
  const root = await mkdtemp(path.join(tmpdir(), "sf-u4-src-"));
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

function branchList(cachePath: string, branch: string): string {
  return git(cachePath, ["branch", "--list", branch]);
}

async function materializeRepoRun(options?: {
  runId?: string;
  repository?: string;
}): Promise<{
  meta: RunMeta;
  cachePath: string;
  checkoutRoot: string;
  runBranch: string;
}> {
  const runId = options?.runId ?? "run-reclaim-1";
  const repository = options?.repository ?? "acme/reclaim";
  const runBranch = `stageflow/run-${runId}`;
  const checkoutRoot = worktreePathForRun(runId);

  const { root: source, sha } = await createSourceRepo();
  setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);
  const { cachePath } = await ensureBareCache(repository, "main");
  mkdirSync(path.dirname(checkoutRoot), { recursive: true });
  await worktreeAdd(cachePath, {
    worktreePath: checkoutRoot,
    branch: runBranch,
    startPoint: sha,
  });

  const meta: RunMeta = {
    run_id: runId,
    pipeline_id: "pipe",
    created_at: new Date().toISOString(),
    repository,
    ref: "main",
    resolved_sha: sha,
    checkout_root: checkoutRoot,
    run_branch: runBranch,
  };
  return { meta, cachePath, checkoutRoot, runBranch };
}

async function createBoundStoreRun(options?: {
  runId?: string;
  repository?: string;
}): Promise<{
  store: ReturnType<typeof createRunStore>;
  runId: string;
  cachePath: string;
  checkoutRoot: string;
  runBranch: string;
  sha: string;
}> {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-u2-store-"));
  temps.push(storeRoot);
  const store = createRunStore({ rootDir: storeRoot });
  const { meta, cachePath, checkoutRoot, runBranch } =
    await materializeRepoRun(options);
  const created = await store.createRun({
    runId: meta.run_id,
    pipelineId: "docs-only",
    taskYaml: "id: t\ngoal: g\n",
    taskId: "t",
    repository: meta.repository,
    ref: meta.ref,
    resolvedSha: meta.resolved_sha,
    checkoutRoot: meta.checkout_root,
    runBranch: meta.run_branch,
  });
  return {
    store,
    runId: created.runId,
    cachePath,
    checkoutRoot,
    runBranch,
    sha: meta.resolved_sha!,
  };
}

beforeEach(async () => {
  stashEnv(["STAGEFLOW_HOME", "GITHUB_TOKEN", "GH_TOKEN"]);
  resetGlobalStageflowHomeForTests();
  resetBareCacheStateForTests();
  setBareCacheRemoteUrlOverrideForTests(null);
  const home = await mkdtemp(path.join(tmpdir(), "sf-u4-home-"));
  temps.push(home);
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  process.env.GITHUB_TOKEN = "ghp_TestTokenForU4XXXXXXXXXXXXXXX";
});

afterEach(async () => {
  setBareCacheRemoteUrlOverrideForTests(null);
  resetBareCacheStateForTests();
  restoreEnv(["STAGEFLOW_HOME", "GITHUB_TOKEN", "GH_TOKEN"]);
  resetGlobalStageflowHomeForTests();
  vi.restoreAllMocks();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(!gitAvailable)("reclaimWorkspaceBinding (U4)", () => {
  it("removes the worktree and run branch for a repository-bound run", async () => {
    const { meta, cachePath, checkoutRoot, runBranch } =
      await materializeRepoRun();
    expect(existsSync(checkoutRoot)).toBe(true);
    expect(branchList(cachePath, runBranch)).toContain(runBranch);

    await reclaimWorkspaceBinding(meta);

    expect(existsSync(checkoutRoot)).toBe(false);
    expect(branchList(cachePath, runBranch)).toBe("");
  });

  it("swallows a missing worktree and still prunes then deletes the branch", async () => {
    const { meta, cachePath, checkoutRoot, runBranch } =
      await materializeRepoRun({ runId: "run-missing-wt" });
    await rm(checkoutRoot, { recursive: true, force: true });
    expect(existsSync(checkoutRoot)).toBe(false);

    const pruneSpy = vi.spyOn(operations, "worktreePrune");
    const deleteSpy = vi.spyOn(operations, "deleteBranch");

    await expect(reclaimWorkspaceBinding(meta)).resolves.toBeUndefined();

    expect(pruneSpy).toHaveBeenCalledWith(cachePath);
    expect(deleteSpy).toHaveBeenCalledWith(cachePath, runBranch);
    expect(branchList(cachePath, runBranch)).toBe("");
  });

  it("is a no-op for unbound and path-checkout metas (no git calls)", async () => {
    const removeSpy = vi.spyOn(operations, "worktreeRemove");
    const pruneSpy = vi.spyOn(operations, "worktreePrune");
    const deleteSpy = vi.spyOn(operations, "deleteBranch");

    const unbound: RunMeta = {
      run_id: "run-unbound",
      pipeline_id: "pipe",
      created_at: new Date().toISOString(),
    };
    await reclaimWorkspaceBinding(unbound);

    const checkout: RunMeta = {
      run_id: "run-checkout",
      pipeline_id: "pipe",
      created_at: new Date().toISOString(),
      checkout_root: "/tmp/some-checkout",
    };
    await reclaimWorkspaceBinding(checkout);

    expect(removeSpy).not.toHaveBeenCalled();
    expect(pruneSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("swallows an already-deleted branch and still resolves", async () => {
    const { meta, cachePath, checkoutRoot, runBranch } =
      await materializeRepoRun({ runId: "run-no-branch" });
    await operations.worktreeRemove(cachePath, checkoutRoot);
    await operations.worktreePrune(cachePath);
    await operations.deleteBranch(cachePath, runBranch);
    expect(branchList(cachePath, runBranch)).toBe("");

    await expect(reclaimWorkspaceBinding(meta)).resolves.toBeUndefined();
  });

  it("repeat reclaim on an already-reclaimed run is a silent no-op", async () => {
    const { meta, cachePath, checkoutRoot, runBranch } =
      await materializeRepoRun({ runId: "run-repeat" });
    await reclaimWorkspaceBinding(meta);
    expect(existsSync(checkoutRoot)).toBe(false);
    expect(branchList(cachePath, runBranch)).toBe("");

    await expect(reclaimWorkspaceBinding(meta)).resolves.toBeUndefined();
    expect(existsSync(checkoutRoot)).toBe(false);
    expect(branchList(cachePath, runBranch)).toBe("");
  });

  it("does not introduce shell:true in the reclaim path", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../src/runtime/repositoryMaterialize.ts", import.meta.url),
        "utf8",
      ),
    );
    const reclaimBlock = source.slice(
      source.indexOf("export async function reclaimWorkspaceBinding"),
      source.indexOf("export async function materializeWorkspaceBinding"),
    );
    expect(reclaimBlock).not.toMatch(/shell\s*:\s*true/);
    expect(reclaimBlock).toContain("worktreeRemove");
    expect(reclaimBlock).toContain("worktreePrune");
    expect(reclaimBlock).toContain("deleteBranch");
    expect(reclaimBlock).toContain("bareCachePath");
    expect(reclaimBlock).toContain("reclaimWorkspaceOnRunSucceeded");
    expect(reclaimBlock).toContain("keepRunBranch: true");
  });
});

describe.skipIf(!gitAvailable)("reclaim on run succeeded (U2)", () => {
  it("writeTerminalRunStatus succeeded removes worktree, keeps branch and checkout_root, leaves slimmed_at unset", async () => {
    const { store, runId, cachePath, checkoutRoot, runBranch } =
      await createBoundStoreRun({ runId: "run-succeed-wt" });
    expect(existsSync(checkoutRoot)).toBe(true);

    await writeTerminalRunStatus(store, runId, "succeeded");

    const meta = await store.readRunMeta(runId);
    expect(meta.status).toBe("succeeded");
    expect(existsSync(checkoutRoot)).toBe(false);
    expect(branchList(cachePath, runBranch)).toContain(runBranch);
    expect(meta.checkout_root).toBe(checkoutRoot);
    expect(meta.run_branch).toBe(runBranch);
    expect(meta.slimmed_at).toBeUndefined();
  });

  it("syncRunStatusFromStages derived succeeded reclaims the worktree", async () => {
    const { store, runId, cachePath, checkoutRoot, runBranch } =
      await createBoundStoreRun({ runId: "run-sync-succeed" });
    await store.appendStageEvent(runId, "build", { event: "started" });
    await store.appendStageEvent(runId, "build", { event: "succeeded" });
    await store.updateRunStatus(runId, "running");
    expect(existsSync(checkoutRoot)).toBe(true);

    await syncRunStatusFromStages(store, runId);

    const meta = await store.readRunMeta(runId);
    expect(meta.status).toBe("succeeded");
    expect(existsSync(checkoutRoot)).toBe(false);
    expect(branchList(cachePath, runBranch)).toContain(runBranch);
    expect(meta.checkout_root).toBe(checkoutRoot);
    expect(meta.slimmed_at).toBeUndefined();
  });

  it("reclaim throw leaves run status succeeded", async () => {
    const { store, runId, checkoutRoot } = await createBoundStoreRun({
      runId: "run-reclaim-throw",
    });
    const orig = store.readRunMeta.bind(store);
    vi.spyOn(store, "readRunMeta").mockImplementation(async (id) => {
      const meta = await orig(id);
      if (meta.status === "succeeded") {
        throw new Error("reclaim boom");
      }
      return meta;
    });

    await expect(
      writeTerminalRunStatus(store, runId, "succeeded"),
    ).resolves.toBeUndefined();

    vi.mocked(store.readRunMeta).mockRestore();
    const meta = await store.readRunMeta(runId);
    expect(meta.status).toBe("succeeded");
    expect(existsSync(checkoutRoot)).toBe(true);
  });

  it("multi-stage: worktree present after stage1; gone after run succeeded", async () => {
    const { store, runId, checkoutRoot } = await createBoundStoreRun({
      runId: "run-multi-stage",
    });
    await store.appendStageEvent(runId, "stage1", { event: "started" });
    await store.appendStageEvent(runId, "stage1", { event: "succeeded" });
    await store.updateRunStatus(runId, "running");
    expect(existsSync(checkoutRoot)).toBe(true);

    await store.appendStageEvent(runId, "stage2", { event: "started" });
    await store.appendStageEvent(runId, "stage2", { event: "succeeded" });
    await writeTerminalRunStatus(store, runId, "succeeded");

    expect(existsSync(checkoutRoot)).toBe(false);
    const meta = await store.readRunMeta(runId);
    expect(meta.status).toBe("succeeded");
    expect(meta.checkout_root).toBe(checkoutRoot);
  });

  it("failed terminal status leaves the worktree", async () => {
    const { store, runId, checkoutRoot, cachePath, runBranch } =
      await createBoundStoreRun({ runId: "run-fail-keep" });

    await writeTerminalRunStatus(store, runId, "failed");

    expect(existsSync(checkoutRoot)).toBe(true);
    expect(branchList(cachePath, runBranch)).toContain(runBranch);
    const meta = await store.readRunMeta(runId);
    expect(meta.status).toBe("failed");
  });

  it("cancelled run is not overwritten and leaves the worktree", async () => {
    const { store, runId, checkoutRoot } = await createBoundStoreRun({
      runId: "run-cancel-keep",
    });
    await store.updateRunStatus(runId, "cancelled");
    await store.setCancelReason(runId, "operator cancelled");

    await writeTerminalRunStatus(store, runId, "succeeded");

    expect(existsSync(checkoutRoot)).toBe(true);
    const meta = await store.readRunMeta(runId);
    expect(meta.status).toBe("cancelled");
  });

  it("reclaimWorkspaceOnRunSucceeded is idempotent when worktree already gone", async () => {
    const { store, runId, checkoutRoot, cachePath, runBranch } =
      await createBoundStoreRun({ runId: "run-idempotent" });
    await reclaimWorkspaceOnRunSucceeded(store, runId);
    expect(existsSync(checkoutRoot)).toBe(false);
    expect(branchList(cachePath, runBranch)).toContain(runBranch);

    await expect(
      reclaimWorkspaceOnRunSucceeded(store, runId),
    ).resolves.toBeUndefined();
    const meta = await store.readRunMeta(runId);
    expect(meta.checkout_root).toBe(checkoutRoot);
    expect(meta.slimmed_at).toBeUndefined();
  });
});
