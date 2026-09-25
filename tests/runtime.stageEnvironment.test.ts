import { describe, expect, it } from "vitest";
import {
  AMBIENT_BLOCKED_ENV_NAMES,
  FOREVER_DENIED_SECRET_NAMES,
  STAGE_ENV_ALLOW,
  STAGE_ENV_PASSTHROUGH,
  buildStageEnvironment,
  envNameSet,
  isForeverDeniedSecret,
} from "../src/runtime/stageEnvironment.js";
import { SF_STAGE_WORKER } from "../src/runtime/stageWorkerProtocol.js";
import { BashPreflightError, resolveBashPath } from "../src/preflight/bash.js";

describe("buildStageEnvironment", () => {
  const baseHost = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/operator",
    USER: "op",
    LANG: "en_US.UTF-8",
    STAGEFLOW_HOME: "/tmp/sf-home",
    STAGEFLOW_CONTROL_TOKEN: "control-token-value-32chars-min!!",
    STAGEFLOW_READ_TOKEN: "read-token-value-32-characters-ok!",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghp_secret_token_value",
    CUSTOM_OK: "custom-value",
    HTTP_PROXY: "http://proxy.example:8080",
  };

  it("allowlist-only child omits denylisted and undeclared ambient vars", () => {
    const { env, warnings, passthroughActive } = buildStageEnvironment({
      hostEnv: baseHost,
      attemptHome: "/tmp/attempt-home",
    });
    expect(passthroughActive).toBe(false);
    expect(warnings).toEqual([]);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.STAGEFLOW_HOME).toBe("/tmp/sf-home");
    expect(env.HTTP_PROXY).toBe("http://proxy.example:8080");
    expect(env.HOME).toBe("/tmp/attempt-home");
    expect(env[SF_STAGE_WORKER]).toBe("1");
    expect(env.STAGEFLOW_CONTROL_TOKEN).toBeUndefined();
    expect(env.STAGEFLOW_READ_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CUSTOM_OK).toBeUndefined();
    expect(env.USER).toBe("op");
  });

  it("PASSTHROUGH=all restores ambient non-denylisted vars and warns", () => {
    const { env, warnings, passthroughActive } = buildStageEnvironment({
      hostEnv: { ...baseHost, [STAGE_ENV_PASSTHROUGH]: "all" },
      packageVersion: "0.24.0",
      grants: {
        env: {},
        registeredSecretNames: ["MY_SECRET"],
        declaredSecretNames: [],
      },
    });
    expect(passthroughActive).toBe(true);
    expect(warnings.some((w) => w.includes("0.26.0"))).toBe(true);
    expect(env.CUSTOM_OK).toBe("custom-value");
    expect(env.STAGEFLOW_CONTROL_TOKEN).toBeUndefined();
    expect(env.STAGEFLOW_READ_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
  });

  it("PASSTHROUGH skips undeclared registered NAME_FILE siblings", () => {
    const { env } = buildStageEnvironment({
      hostEnv: {
        ...baseHost,
        [STAGE_ENV_PASSTHROUGH]: "all",
        MY_SECRET: "registered-secret-value",
        MY_SECRET_FILE: "/host/secrets/my-secret",
      },
      grants: {
        env: {},
        registeredSecretNames: ["MY_SECRET"],
        declaredSecretNames: [],
      },
    });
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.MY_SECRET_FILE).toBeUndefined();
  });

  it("ALLOW adds named var; denylist still wins", () => {
    const { env } = buildStageEnvironment({
      hostEnv: {
        ...baseHost,
        [STAGE_ENV_ALLOW]: "CUSTOM_OK,STAGEFLOW_CONTROL_TOKEN,GITHUB_TOKEN",
      },
    });
    expect(env.CUSTOM_OK).toBe("custom-value");
    expect(env.STAGEFLOW_CONTROL_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("as:env grant can inject GITHUB_TOKEN but never control token", () => {
    const { env } = buildStageEnvironment({
      hostEnv: baseHost,
      grants: {
        env: {
          GITHUB_TOKEN: "ghp_granted",
          STAGEFLOW_CONTROL_TOKEN: "should-not-appear",
        },
        registeredSecretNames: ["GITHUB_TOKEN", "STAGEFLOW_CONTROL_TOKEN"],
        declaredSecretNames: ["GITHUB_TOKEN", "STAGEFLOW_CONTROL_TOKEN"],
      },
    });
    expect(env.GITHUB_TOKEN).toBe("ghp_granted");
    expect(env.STAGEFLOW_CONTROL_TOKEN).toBeUndefined();
    expect(isForeverDeniedSecret("STAGEFLOW_CONTROL_TOKEN")).toBe(true);
    expect(FOREVER_DENIED_SECRET_NAMES.has("STAGEFLOW_READ_TOKEN")).toBe(true);
    expect(AMBIENT_BLOCKED_ENV_NAMES.has("GITHUB_TOKEN")).toBe(true);
  });

  it("runVars and cacheVars appear in the constructed env", () => {
    const { env } = buildStageEnvironment({
      hostEnv: baseHost,
      runVars: { STAGEFLOW_CHECKOUT: "/wt/run-1" },
      cacheVars: { STAGEFLOW_CACHE: "/tmp/sf-home/cache" },
    });
    expect(env.STAGEFLOW_CHECKOUT).toBe("/wt/run-1");
    expect(env.STAGEFLOW_CACHE).toBe("/tmp/sf-home/cache");
  });

  it("fork and verify share identical name sets for a fixed input", () => {
    const input = {
      hostEnv: baseHost,
      runVars: { STAGEFLOW_RUN_WORKSPACE: "/ws" },
      cacheVars: { STAGEFLOW_CACHE: "/cache" },
      attemptHome: "/empty-home",
    };
    const a = envNameSet(buildStageEnvironment(input).env);
    const b = envNameSet(buildStageEnvironment(input).env);
    expect([...a].sort()).toEqual([...b].sort());
  });
});

describe("resolveBashPath", () => {
  it("resolves bash on PATH", () => {
    const bash = resolveBashPath(process.env);
    expect(bash.length).toBeGreaterThan(0);
    expect(bash.endsWith("bash") || bash.includes("/bash")).toBe(true);
  });

  it("missing bash → named error", () => {
    expect(() => resolveBashPath({ PATH: "/nonexistent/bin" })).toThrow(
      BashPreflightError,
    );
    try {
      resolveBashPath({ PATH: "/nonexistent/bin" });
    } catch (err) {
      expect(err).toBeInstanceOf(BashPreflightError);
      expect((err as BashPreflightError).code).toBe("bash_not_found");
    }
  });
});
