import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultBranchNameForTask,
  ensureWorktreeCheckout,
  sanitizeBranchForPath,
  worktreePathFor,
} from "../src/runtime/gitWorktreeCheckout.js";

const roots: string[] = [];
// worktreePathFor puts worktrees beside the project root's *parent* — in
// these tests that's the shared OS tmpdir, which other test files (and
// parallel vitest workers) also use. Track exactly the paths this file
// creates and remove only those, rather than nuking the whole shared
// `.stageflow-worktrees` directory (that raced with other test files'
// worktrees running in parallel and caused real intermittent failures).
const worktreePaths: string[] = [];

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-worktree-checkout-"));
  roots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function ensureAndTrack(
  params: Parameters<typeof ensureWorktreeCheckout>[0],
): Promise<string> {
  const worktreePath = await ensureWorktreeCheckout(params);
  worktreePaths.push(worktreePath);
  return worktreePath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(
    worktreePaths.splice(0).map((worktreePath) => rm(worktreePath, { recursive: true, force: true })),
  );
});

describe("sanitizeBranchForPath / worktreePathFor / defaultBranchNameForTask", () => {
  it("sanitizes slashes and other unsafe characters out of a branch name for use as a path segment", () => {
    expect(sanitizeBranchForPath("feature/foo bar")).toBe("feature-foo-bar");
  });

  it("derives a default branch name from the task id", () => {
    expect(defaultBranchNameForTask("ship-widget")).toBe("stageflow/ship-widget");
  });

  it("places the worktree as a sibling of the project root, not nested inside it", () => {
    const target = worktreePathFor("/repo/project", "feature/foo");
    expect(target).toBe("/repo/.stageflow-worktrees/feature-foo");
  });
});

describe("ensureWorktreeCheckout", () => {
  it("creates a new branch from HEAD and a worktree checked out to it when neither exists", async () => {
    const root = await makeRepo();
    const worktreePath = await ensureAndTrack({
      projectRoot: root,
      branch: "feature/new-thing",
      taskId: "ignored-when-branch-given",
    });

    expect(worktreePath).toBe(worktreePathFor(await realpath(root), "feature/new-thing"));
    const content = await readFile(path.join(worktreePath, "README.md"), "utf8");
    expect(content).toBe("hello\n");
    const branchOutput = await git(worktreePath, ["branch", "--show-current"]);
    expect(branchOutput.trim()).toBe("feature/new-thing");
  });

  it("reuses an already-existing branch instead of trying to create it again", async () => {
    const root = await makeRepo();
    await git(root, ["branch", "already-exists"]);

    const worktreePath = await ensureAndTrack({
      projectRoot: root,
      branch: "already-exists",
      taskId: "unused",
    });

    const branchOutput = await git(worktreePath, ["branch", "--show-current"]);
    expect(branchOutput.trim()).toBe("already-exists");
  });

  it("uses the given base ref instead of HEAD when creating a new branch", async () => {
    const root = await makeRepo();
    await git(root, ["checkout", "-b", "base-branch"]);
    await writeFile(path.join(root, "extra.txt"), "extra\n");
    await git(root, ["add", "extra.txt"]);
    await git(root, ["commit", "-m", "extra commit on base-branch"]);
    await git(root, ["checkout", "-"]);

    const worktreePath = await ensureAndTrack({
      projectRoot: root,
      branch: "from-base",
      base: "base-branch",
      taskId: "unused",
    });

    const files = await readFile(path.join(worktreePath, "extra.txt"), "utf8");
    expect(files).toBe("extra\n");
  });

  it("auto-generates a branch name from the task id when no branch is given", async () => {
    const root = await makeRepo();
    const worktreePath = await ensureAndTrack({
      projectRoot: root,
      taskId: "ship-widget",
    });

    expect(worktreePath).toBe(worktreePathFor(await realpath(root), "stageflow/ship-widget"));
  });

  it("is idempotent: calling it twice with identical args returns the same path without erroring", async () => {
    const root = await makeRepo();
    const first = await ensureAndTrack({
      projectRoot: root,
      branch: "double-call",
      taskId: "unused",
    });
    const second = await ensureAndTrack({
      projectRoot: root,
      branch: "double-call",
      taskId: "unused",
    });

    expect(second).toBe(first);
    const list = await git(root, ["worktree", "list", "--porcelain"]);
    expect(list.split(`worktree ${first}`).length - 1).toBe(1);
  });

  it("rejects a branch name that could be reinterpreted by git as a flag", async () => {
    const root = await makeRepo();
    await expect(
      ensureWorktreeCheckout({ projectRoot: root, branch: "--upload-pack=x", taskId: "unused" }),
    ).rejects.toThrow(/must not start with "-"/);
  });

  it("rejects a base ref that could be reinterpreted by git as a flag", async () => {
    const root = await makeRepo();
    await expect(
      ensureWorktreeCheckout({
        projectRoot: root,
        branch: "fine",
        base: "-f",
        taskId: "unused",
      }),
    ).rejects.toThrow(/must not start with "-"/);
  });

  it("throws a clear error when the target path exists but isn't a registered worktree", async () => {
    const root = await makeRepo();
    const target = worktreePathFor(root, "collides");
    worktreePaths.push(target);
    await mkdir(target, { recursive: true });

    await expect(
      ensureWorktreeCheckout({ projectRoot: root, branch: "collides", taskId: "unused" }),
    ).rejects.toThrow(/not a registered git worktree/);
  });

  it("recreates the worktree when it was registered but its directory was deleted out from under git", async () => {
    const root = await makeRepo();
    const first = await ensureAndTrack({
      projectRoot: root,
      branch: "deleted-dir",
      taskId: "unused",
    });
    await rm(first, { recursive: true, force: true });

    const second = await ensureAndTrack({
      projectRoot: root,
      branch: "deleted-dir",
      taskId: "unused",
    });

    expect(second).toBe(first);
    const content = await readFile(path.join(second, "README.md"), "utf8");
    expect(content).toBe("hello\n");
  });
});
