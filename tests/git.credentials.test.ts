import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError } from "../src/git/errors.js";
import {
  ensureAskpassHelper,
  hostGitAskpassEnv,
  readHostGithubToken,
} from "../src/git/credentials.js";
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

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-cred-home-"));
  temps.push(dir);
  return dir;
}

beforeEach(() => {
  stashEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN_FILE",
    "GH_TOKEN_FILE",
  ]);
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  restoreEnv([
    "STAGEFLOW_HOME",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN_FILE",
    "GH_TOKEN_FILE",
  ]);
  resetGlobalStageflowHomeForTests();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("git credentials", () => {
  it("reads GITHUB_TOKEN and GH_TOKEN, preferring GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "ghp_FromGithubTokenXXXXXXXXXXXX";
    process.env.GH_TOKEN = "ghp_FromGhTokenXXXXXXXXXXXXXXXX";
    expect(readHostGithubToken()).toBe("ghp_FromGithubTokenXXXXXXXXXXXX");
  });

  it("reads token from GITHUB_TOKEN_FILE when inline env is absent", async () => {
    const home = await tempHome();
    const tokenFile = path.join(home, "token");
    await writeFile(tokenFile, "ghp_FromFileTokenYYYYYYYYYYYYYY\n", "utf8");
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN_FILE = tokenFile;
    expect(readHostGithubToken()).toBe("ghp_FromFileTokenYYYYYYYYYYYYYY");
  });

  it("writes askpass under durable home with mode 0700 and branches Username vs Password", async () => {
    const home = await tempHome();
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();

    const askpass = ensureAskpassHelper();
    expect(askpass).toBe(path.join(home, "git-askpass"));
    await access(askpass, constants.X_OK);
    const mode = (await stat(askpass)).mode & 0o777;
    expect(mode).toBe(0o700);

    const token = "ghp_AskpassBranchTokenZZZZZZZZZZZZ";
    process.env.GITHUB_TOKEN = token;
    const env = hostGitAskpassEnv();
    expect(env.GIT_ASKPASS).toBe(askpass);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(process.env.GIT_ASKPASS).toBeUndefined();

    const { execFileSync } = await import("node:child_process");
    const user = execFileSync(askpass, ["Username for 'https://github.com':"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
    const pass = execFileSync(askpass, ["Password for 'https://github.com':"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
    expect(user).toBe("x-access-token");
    expect(pass).toBe(token);
  });

  it("fails fast as auth when no token is available", async () => {
    const home = await tempHome();
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN_FILE;
    delete process.env.GH_TOKEN_FILE;

    expect(() => hostGitAskpassEnv({ requireToken: true })).toThrow(GitError);
    try {
      hostGitAskpassEnv({ requireToken: true });
    } catch (error) {
      expect(error).toMatchObject({
        name: "GitError",
        code: "auth_failed",
        stderr:
          "GITHUB_TOKEN (or GH_TOKEN / GITHUB_TOKEN_FILE / GH_TOKEN_FILE) is required for repository binding (clone/fetch and later push/PR). Set it on the Host process environment before start.",
      });
    }
  });

  it("does not place the askpass helper under worktrees/", async () => {
    const home = await tempHome();
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const askpass = ensureAskpassHelper();
    expect(askpass.startsWith(path.join(home, "worktrees"))).toBe(false);
    expect(path.dirname(askpass)).toBe(home);
  });
});
