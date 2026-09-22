import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bareCachePath,
  ensureBareCache,
  githubHttpsRemoteUrl,
  resetBareCacheStateForTests,
  setBareCacheRemoteUrlOverrideForTests,
} from "../src/git/cache.js";
import * as operations from "../src/git/operations.js";
import { GitError } from "../src/git/errors.js";
import {
  resetGlobalStageflowHomeForTests,
} from "../src/project/globalHome.js";
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

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function createSourceRepo(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-cache-src-"));
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

beforeEach(async () => {
  stashEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN_FILE",
    "GH_TOKEN_FILE",
    "GIT_ASKPASS",
  ]);
  resetGlobalStageflowHomeForTests();
  resetBareCacheStateForTests();
  setBareCacheRemoteUrlOverrideForTests(null);
  const home = await mkdtemp(path.join(tmpdir(), "sf-cache-home-"));
  temps.push(home);
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  process.env.GITHUB_TOKEN = "ghp_TestTokenForCacheXXXXXXXXXXXX";
});

afterEach(async () => {
  setBareCacheRemoteUrlOverrideForTests(null);
  resetBareCacheStateForTests();
  restoreEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN_FILE",
    "GH_TOKEN_FILE",
    "GIT_ASKPASS",
  ]);
  resetGlobalStageflowHomeForTests();
  vi.restoreAllMocks();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!gitAvailable)("git bare cache", () => {
  it("derives cache layout under repos/github.com/<owner>/<repo>.git", () => {
    const home = process.env.STAGEFLOW_HOME!;
    expect(bareCachePath("acme/api")).toBe(
      path.join(home, "repos", "github.com", "acme", "api.git"),
    );
    expect(githubHttpsRemoteUrl("acme/api")).toBe("https://github.com/acme/api.git");
  });

  it("second ensure reuses the mirror and SHA-present skip does not fetch", async () => {
    const { root: source, sha } = await createSourceRepo();
    const url = pathToFileURL(source).href;
    setBareCacheRemoteUrlOverrideForTests(() => url);

    const remoteUpdateSpy = vi.spyOn(operations, "remoteUpdate");
    const cloneSpy = vi.spyOn(operations, "cloneBare");

    const first = await ensureBareCache("acme/api", "main");
    expect(first.cachePath).toBe(bareCachePath("acme/api"));
    expect(existsSync(first.cachePath)).toBe(true);
    expect(first.fetched).toBe(true);
    expect(cloneSpy.mock.calls.length + remoteUpdateSpy.mock.calls.length).toBeGreaterThan(0);

    const clonesAfterFirst = cloneSpy.mock.calls.length;
    const updatesAfterFirst = remoteUpdateSpy.mock.calls.length;

    const second = await ensureBareCache("acme/api", "main");
    expect(second.cachePath).toBe(first.cachePath);
    expect(cloneSpy.mock.calls.length).toBe(clonesAfterFirst);

    const updatesBeforeSha = remoteUpdateSpy.mock.calls.length;
    const shaEnsure = await ensureBareCache("acme/api", sha);
    expect(shaEnsure.fetched).toBe(false);
    expect(remoteUpdateSpy.mock.calls.length).toBe(updatesBeforeSha);
    expect(cloneSpy.mock.calls.length).toBe(clonesAfterFirst);
    expect(updatesAfterFirst).toBeGreaterThanOrEqual(0);
  });

  it("serializes concurrent ensure on the same cache", async () => {
    const { root: source } = await createSourceRepo();
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    let inFlight = 0;
    let maxInFlight = 0;
    const realRemoteUpdate = operations.remoteUpdate.bind(operations);
    const realCloneBare = operations.cloneBare.bind(operations);

    vi.spyOn(operations, "cloneBare").mockImplementation(async (...args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      try {
        return await realCloneBare(...args);
      } finally {
        inFlight -= 1;
      }
    });
    vi.spyOn(operations, "remoteUpdate").mockImplementation(async (...args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      try {
        return await realRemoteUpdate(...args);
      } finally {
        inFlight -= 1;
      }
    });

    await Promise.all([
      ensureBareCache("acme/api", "main"),
      ensureBareCache("acme/api", "main"),
      ensureBareCache("acme/api", "main"),
    ]);

    expect(maxInFlight).toBe(1);
    expect(existsSync(bareCachePath("acme/api"))).toBe(true);
  });

  it("never puts the token in the remote URL or git config", async () => {
    const { root: source } = await createSourceRepo();
    const token = "ghp_MustNeverAppearInGitConfigABCDEF";
    process.env.GITHUB_TOKEN = token;
    setBareCacheRemoteUrlOverrideForTests(() => pathToFileURL(source).href);

    const { cachePath } = await ensureBareCache("acme/api", "main");
    const remote = execFileSync("git", ["-C", cachePath, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
    expect(remote).not.toContain(token);
    expect(remote.startsWith("http://") || remote.startsWith("https://") || remote.startsWith("file:")).toBe(
      true,
    );

    const config = await readFile(path.join(cachePath, "config"), "utf8");
    expect(config).not.toContain(token);

    expect(githubHttpsRemoteUrl("acme/api")).not.toContain(token);
  });

  it("fails fast as auth when token is missing for GitHub HTTPS", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN_FILE;
    delete process.env.GH_TOKEN_FILE;
    setBareCacheRemoteUrlOverrideForTests(null);

    await expect(ensureBareCache("acme/api", "main")).rejects.toMatchObject({
      name: "GitError",
      code: "auth_failed",
    } satisfies Partial<GitError>);
  });
});
