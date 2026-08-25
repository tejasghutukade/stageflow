import { describe, expect, it } from "vitest";
import { resolveCiIdentity } from "../src/cli/ciIdentity.js";

const actionsEnv = {
  GITHUB_SHA: "aaa111",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/repo",
  GITHUB_RUN_ID: "99",
  GITHUB_JOB: "build",
};

describe("resolveCiIdentity", () => {
  it("fills gitSha and workflow run URL from env and omits PR on push", () => {
    const identity = resolveCiIdentity({
      flags: {},
      env: {
        ...actionsEnv,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
      },
    });
    expect(identity.gitSha).toBe("aaa111");
    expect(identity.ciJobUrl).toBe(
      "https://github.com/acme/repo/actions/runs/99",
    );
    expect(identity.ciPrUrl).toBeUndefined();
    expect(identity.ciJobUrl).not.toMatch(/\/job\//);
  });

  it("constructs ciPrUrl from refs/pull/<N>/", () => {
    const identity = resolveCiIdentity({
      flags: {},
      env: {
        ...actionsEnv,
        GITHUB_REF: "refs/pull/42/merge",
        GITHUB_REF_NAME: "42/merge",
      },
    });
    expect(identity.ciPrUrl).toBe("https://github.com/acme/repo/pull/42");
  });

  it("constructs ciPrUrl from GITHUB_REF_NAME <N>/merge", () => {
    const identity = resolveCiIdentity({
      flags: {},
      env: {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo",
        GITHUB_REF_NAME: "42/merge",
      },
    });
    expect(identity.ciPrUrl).toBe("https://github.com/acme/repo/pull/42");
  });

  it("does not treat GITHUB_HEAD_REF as a PR number", () => {
    const identity = resolveCiIdentity({
      flags: {},
      env: {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo",
        GITHUB_REF: "refs/heads/feature",
        GITHUB_HEAD_REF: "42",
      },
    });
    expect(identity.ciPrUrl).toBeUndefined();
  });

  it("lets --ci-job-url override the env workflow run URL", () => {
    const jobUrl =
      "https://github.com/acme/repo/actions/runs/99/job/123456789";
    const identity = resolveCiIdentity({
      flags: { ciJobUrl: jobUrl },
      env: actionsEnv,
    });
    expect(identity.ciJobUrl).toBe(jobUrl);
    expect(identity.gitSha).toBe("aaa111");
  });

  it("does not append GITHUB_JOB onto the env run URL", () => {
    const identity = resolveCiIdentity({
      flags: {},
      env: {
        ...actionsEnv,
        GITHUB_JOB: "build",
      },
    });
    expect(identity.ciJobUrl).toBe(
      "https://github.com/acme/repo/actions/runs/99",
    );
    expect(identity.ciJobUrl).not.toContain("/job/build");
    expect(identity.ciJobUrl).not.toMatch(/\/job\//);
  });

  it("omits all fields for empty env", () => {
    expect(resolveCiIdentity({ flags: {}, env: {} })).toEqual({});
  });

  it("omits whitespace-only SHA and flags", () => {
    const identity = resolveCiIdentity({
      flags: { gitSha: "  ", ciPrUrl: "\t", ciJobUrl: " " },
      env: { GITHUB_SHA: "   " },
    });
    expect(identity.gitSha).toBeUndefined();
    expect(identity.ciPrUrl).toBeUndefined();
    expect(identity.ciJobUrl).toBeUndefined();
  });

  it("lets --git-sha override GITHUB_SHA while other fields still fill from env", () => {
    const identity = resolveCiIdentity({
      flags: { gitSha: "deadbeef" },
      env: {
        ...actionsEnv,
        GITHUB_REF: "refs/pull/7/head",
      },
    });
    expect(identity.gitSha).toBe("deadbeef");
    expect(identity.ciPrUrl).toBe("https://github.com/acme/repo/pull/7");
    expect(identity.ciJobUrl).toBe(
      "https://github.com/acme/repo/actions/runs/99",
    );
  });

  it("omits ciJobUrl when GITHUB_RUN_ID is missing", () => {
    const identity = resolveCiIdentity({
      flags: {},
      env: {
        GITHUB_SHA: "aaa111",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo",
        GITHUB_JOB: "build",
      },
    });
    expect(identity.gitSha).toBe("aaa111");
    expect(identity.ciJobUrl).toBeUndefined();
  });
});
