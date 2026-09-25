import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitError } from "../src/git/errors.js";
import { runGit, runGitSync } from "../src/git/exec.js";

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

async function writeFakeGit(script: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-fake-git-"));
  temps.push(dir);
  const bin = path.join(dir, "git");
  await writeFile(bin, script, { encoding: "utf8", mode: 0o755 });
  await chmod(bin, 0o755);
  return bin;
}

describe.skipIf(!gitAvailable)("runGit / runGitSync", () => {
  it("returns stdout for a successful invocation", async () => {
    const result = await runGit({ args: ["--version"], timeoutMs: 5_000 });
    expect(result.stdout).toMatch(/git version/i);
    expect(result.exitCode).toBe(0);
  });

  it("classifies a missing binary as git_missing", async () => {
    await expect(
      runGit({
        gitBin: path.join(tmpdir(), "sf-missing-git-binary-does-not-exist"),
        args: ["--version"],
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      name: "GitError",
      code: "git_missing",
    } satisfies Partial<GitError>);
  });

  it("classifies a tiny timeout as timeout", async () => {
    const bin = await writeFakeGit(`#!/bin/sh
sleep 5
`);
    await expect(
      runGit({ gitBin: bin, args: ["status"], timeoutMs: 50 }),
    ).rejects.toMatchObject({
      name: "GitError",
      code: "timeout",
    } satisfies Partial<GitError>);
  });

  it("redacts a fake token from stderr and the error message", async () => {
    const token = "ghp_FakeTokenForRedactionTestABCDEF123456";
    const bin = await writeFakeGit(`#!/bin/sh
echo 'fatal: Authentication failed for https://x-access-token:${token}@github.com/acme/api.git' >&2
exit 1
`);
    let caught: unknown;
    try {
      await runGit({ gitBin: bin, args: ["fetch"], timeoutMs: 5_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitError);
    const err = caught as GitError;
    expect(err.code).toBe("auth_failed");
    expect(err.stderr).not.toContain(token);
    expect(err.message).not.toContain(token);
    expect(err.stderr).toMatch(/\*\*\*/);
    expect(err.argv).not.toContain(token);
  });

  it("runGitSync returns stdout and sets GIT_TERMINAL_PROMPT=0 by default", () => {
    const result = runGitSync({ args: ["--version"], timeoutMs: 5_000 });
    expect(result.stdout).toMatch(/git version/i);
  });
});
