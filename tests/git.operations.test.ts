import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitError } from "../src/git/errors.js";
import {
  catFileCommit,
  checkRefFormat,
  cloneBare,
  deleteBranch,
  remoteUpdate,
  resolveRef,
  revParse,
  statusPorcelain,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from "../src/git/operations.js";
import { gitVersion } from "../src/git/version.js";
import { runGitSync } from "../src/git/exec.js";

const gitAvailable = (() => {
  try {
    runGitSync({ args: ["--version"], timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function createSourceRepo(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-git-src-"));
  temps.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README"), "hello\n");
  git(root, ["add", "README"]);
  git(root, ["commit", "-m", "init"]);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, sha };
}

describe.skipIf(!gitAvailable)("git operations", () => {
  it("reports gitVersion", async () => {
    const version = await gitVersion();
    expect(version).toMatch(/^\d+\.\d+/);
  });

  it("mirror clones over file:// and adds/removes a worktree", async () => {
    const { root: source, sha } = await createSourceRepo();
    const bare = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-bare-")),
      "mirror.git",
    );
    temps.push(path.dirname(bare));
    const url = pathToFileURL(source).href;
    await cloneBare(url, bare);
    await remoteUpdate(bare);

    const present = await catFileCommit(bare, sha);
    expect(present).toBe(true);

    const resolved = await resolveRef(bare, "refs/heads/main");
    expect(resolved).toBe(sha);

    const worktree = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-wt-")),
      "run-1",
    );
    temps.push(path.dirname(worktree));
    await worktreeAdd(bare, {
      worktreePath: worktree,
      branch: "stageflow/run-1",
      startPoint: sha,
    });

    const head = await revParse(worktree, ["HEAD"]);
    expect(head).toBe(sha);
    expect(statusPorcelain(worktree).trim()).toBe("");

    await worktreeRemove(bare, worktree);
    await worktreePrune(bare);
    await deleteBranch(bare, "stageflow/run-1");
  });

  it("classifies a missing ref as ref_not_found", async () => {
    const { root: source } = await createSourceRepo();
    const bare = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-bare-ref-")),
      "mirror.git",
    );
    temps.push(path.dirname(bare));
    await cloneBare(pathToFileURL(source).href, bare);

    await expect(resolveRef(bare, "refs/heads/does-not-exist")).rejects.toMatchObject({
      name: "GitError",
      code: "ref_not_found",
    } satisfies Partial<GitError>);
  });

  it("classifies a nonexistent file:// remote as repo_not_found", async () => {
    const dest = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-missing-remote-")),
      "mirror.git",
    );
    temps.push(path.dirname(dest));
    const missing = pathToFileURL(
      path.join(tmpdir(), "sf-git-no-such-repo-" + Date.now()),
    ).href;

    await expect(cloneBare(missing, dest)).rejects.toMatchObject({
      name: "GitError",
      code: "repo_not_found",
    } satisfies Partial<GitError>);
  });

  it("validates branch names with checkRefFormat", async () => {
    expect(await checkRefFormat("stageflow/run-abc")).toBe(true);
    expect(await checkRefFormat("bad branch")).toBe(false);
  });
});
