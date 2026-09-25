import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitError } from "../src/git/errors.js";
import {
  BARE_ORIGIN_FETCH_HEADS,
  BARE_ORIGIN_FETCH_TAGS,
  catFileCommit,
  checkRefFormat,
  cloneBare,
  configureBareOriginFetch,
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

function originFetchSpecs(bare: string): string[] {
  return execFileSync("git", ["-C", bare, "config", "--get-all", "remote.origin.fetch"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

  it("bare clones over file:// without mirror and adds/removes a worktree", async () => {
    const { root: source, sha } = await createSourceRepo();
    const bare = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-bare-")),
      "cache.git",
    );
    temps.push(path.dirname(bare));
    const url = pathToFileURL(source).href;
    await cloneBare(url, bare);
    await remoteUpdate(bare);

    let mirror = "";
    try {
      mirror = execFileSync("git", ["-C", bare, "config", "--get", "remote.origin.mirror"], {
        encoding: "utf8",
      }).trim();
    } catch {
      mirror = "";
    }
    expect(mirror).toBe("");
    expect(originFetchSpecs(bare)).toEqual([
      BARE_ORIGIN_FETCH_HEADS,
      BARE_ORIGIN_FETCH_TAGS,
    ]);
    expect(originFetchSpecs(bare)).not.toContain("+refs/*:refs/*");

    const present = await catFileCommit(bare, sha);
    expect(present).toBe(true);

    const resolved = await resolveRef(bare, "main");
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

  it("resolveRef prefers remotes tip over a stale local head", async () => {
    const { root: source, sha: tipSha } = await createSourceRepo();
    const bare = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-bare-stale-")),
      "cache.git",
    );
    temps.push(path.dirname(bare));
    await cloneBare(pathToFileURL(source).href, bare);
    await remoteUpdate(bare);

    const staleSha = execFileSync(
      "git",
      ["-C", bare, "commit-tree", `${tipSha}^{tree}`, "-m", "stale-local-only"],
      { encoding: "utf8" },
    ).trim();
    expect(staleSha).not.toBe(tipSha);
    execFileSync("git", ["-C", bare, "update-ref", "refs/heads/main", staleSha], {
      stdio: "ignore",
    });
    const remotesSha = execFileSync(
      "git",
      ["-C", bare, "rev-parse", "refs/remotes/origin/main"],
      { encoding: "utf8" },
    ).trim();
    expect(remotesSha).toBe(tipSha);

    expect(await resolveRef(bare, "main")).toBe(tipSha);
    expect(await resolveRef(bare, tipSha)).toBe(tipSha);
    expect(await resolveRef(bare, "refs/remotes/origin/main")).toBe(tipSha);
  });

  it("pushes from a linked worktree without mirror/refspec fatal", async () => {
    const { root: source, sha } = await createSourceRepo();
    const bare = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-bare-push-")),
      "cache.git",
    );
    temps.push(path.dirname(bare));
    await cloneBare(pathToFileURL(source).href, bare);

    const worktree = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-wt-push-")),
      "run-push",
    );
    temps.push(path.dirname(worktree));
    await worktreeAdd(bare, {
      worktreePath: worktree,
      branch: "stageflow/run-push",
      startPoint: sha,
    });

    git(worktree, ["config", "user.email", "test@example.com"]);
    git(worktree, ["config", "user.name", "Test"]);
    await writeFile(path.join(worktree, "extra.txt"), "push-me\n");
    git(worktree, ["add", "extra.txt"]);
    git(worktree, ["commit", "-m", "push from worktree"]);

    execFileSync("git", ["push", "-u", "origin", "stageflow/run-push"], {
      cwd: worktree,
      stdio: "pipe",
      encoding: "utf8",
    });

    const remoteSha = execFileSync(
      "git",
      ["-C", source, "rev-parse", "refs/heads/stageflow/run-push"],
      { encoding: "utf8" },
    ).trim();
    const localSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
    }).trim();
    expect(remoteSha).toBe(localSha);
  });

  it("classifies a missing ref as ref_not_found", async () => {
    const { root: source } = await createSourceRepo();
    const bare = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-bare-ref-")),
      "cache.git",
    );
    temps.push(path.dirname(bare));
    await cloneBare(pathToFileURL(source).href, bare);
    await remoteUpdate(bare);

    await expect(resolveRef(bare, "does-not-exist")).rejects.toMatchObject({
      name: "GitError",
      code: "ref_not_found",
    } satisfies Partial<GitError>);
    await expect(resolveRef(bare, "refs/heads/does-not-exist")).rejects.toMatchObject({
      name: "GitError",
      code: "ref_not_found",
    } satisfies Partial<GitError>);
  });

  it("configureBareOriginFetch writes remotes-style heads and tags fetch", async () => {
    const { root: source } = await createSourceRepo();
    const bare = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-bare-cfg-")),
      "cache.git",
    );
    temps.push(path.dirname(bare));
    execFileSync("git", ["clone", "--bare", pathToFileURL(source).href, bare], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", bare, "config", "remote.origin.fetch", "+refs/*:refs/*"], {
      stdio: "ignore",
    });

    await configureBareOriginFetch(bare);
    expect(originFetchSpecs(bare)).toEqual([
      BARE_ORIGIN_FETCH_HEADS,
      BARE_ORIGIN_FETCH_TAGS,
    ]);
  });

  it("classifies a nonexistent file:// remote as repo_not_found", async () => {
    const dest = path.join(
      await mkdtemp(path.join(tmpdir(), "sf-git-missing-remote-")),
      "cache.git",
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
