import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostConfigError,
  loadHostConfig,
  redactHostConfig,
} from "../src/config/hostConfig.js";
import { SecretFromEnvError } from "../src/config/secretFromEnvOrFile.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const temps: string[] = [];

afterEach(() => {
  resetGlobalStageflowHomeForTests();
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sf-hostconfig-"));
  temps.push(dir);
  return dir;
}

describe("loadHostConfig", () => {
  it("fails on unknown config.yaml key with config_unknown_key", () => {
    const home = tempHome();
    writeFileSync(
      path.join(home, "config.yaml"),
      "not_a_real_key: true\n",
      "utf8",
    );
    expect(() =>
      loadHostConfig({
        homeDir: home,
        env: {},
      }),
    ).toThrow(HostConfigError);
    try {
      loadHostConfig({ homeDir: home, env: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(HostConfigError);
      expect((err as HostConfigError).code).toBe("config_unknown_key");
      expect((err as HostConfigError).key).toBe("not_a_real_key");
    }
  });

  it("fails on unknown STAGEFLOW_* env unless allow-unknown", () => {
    const home = tempHome();
    expect(() =>
      loadHostConfig({
        homeDir: home,
        env: { STAGEFLOW_MAX_CONCURRENT_RUN: "3" },
      }),
    ).toThrow(/STAGEFLOW_MAX_CONCURRENT_RUN/);

    const cfg = loadHostConfig({
      homeDir: home,
      env: {
        STAGEFLOW_MAX_CONCURRENT_RUN: "3",
        STAGEFLOW_ALLOW_UNKNOWN_CONFIG: "1",
      },
    });
    expect(cfg.allowUnknownConfig).toBe(true);
    expect(cfg.warnings.some((w) => w.includes("STAGEFLOW_MAX_CONCURRENT_RUN"))).toBe(
      true,
    );
  });

  it("accepts STAGEFLOW_SECRET_REGISTRY as a known env key", () => {
    const home = tempHome();
    expect(() =>
      loadHostConfig({
        homeDir: home,
        env: { STAGEFLOW_SECRET_REGISTRY: "DUMMY_SECRET" },
      }),
    ).not.toThrow();
  });

  it("accepts STAGEFLOW_BUILD_SHA and other Dockerfile Host envs", () => {
    const home = tempHome();
    expect(() =>
      loadHostConfig({
        homeDir: home,
        env: {
          STAGEFLOW_HOME: home,
          STAGEFLOW_BIND: "0.0.0.0",
          STAGEFLOW_NO_AUTOSTART: "1",
          STAGEFLOW_NO_OPEN: "1",
          STAGEFLOW_BUILD_SHA: "abc123def456",
        },
      }),
    ).not.toThrow();
  });

  it("fails boot on STAGEFLOW_MAX_CONCURRENT_RUNS=banana", () => {
    const home = tempHome();
    expect(() =>
      loadHostConfig({
        homeDir: home,
        env: { STAGEFLOW_MAX_CONCURRENT_RUNS: "banana" },
      }),
    ).toThrow(HostConfigError);
    try {
      loadHostConfig({
        homeDir: home,
        env: { STAGEFLOW_MAX_CONCURRENT_RUNS: "banana" },
      });
    } catch (err) {
      expect((err as HostConfigError).code).toBe("config_invalid");
    }
  });

  it("precedence: override > env > file > default", () => {
    const home = tempHome();
    writeFileSync(
      path.join(home, "config.yaml"),
      "max_concurrent_runs: 2\n",
      "utf8",
    );
    const fromFile = loadHostConfig({ homeDir: home, env: {} });
    expect(fromFile.maxConcurrentRuns).toBe(2);

    const fromEnv = loadHostConfig({
      homeDir: home,
      env: { STAGEFLOW_MAX_CONCURRENT_RUNS: "5" },
    });
    expect(fromEnv.maxConcurrentRuns).toBe(5);

    const fromOverride = loadHostConfig({
      homeDir: home,
      env: { STAGEFLOW_MAX_CONCURRENT_RUNS: "5" },
      overrides: { maxConcurrentRuns: 9 },
    });
    expect(fromOverride.maxConcurrentRuns).toBe(9);

    const defaults = loadHostConfig({
      homeDir: tempHome(),
      env: {},
      configFilePath: null,
    });
    expect(defaults.maxConcurrentRuns).toBe(3);
  });

  it("both plain and _FILE secret → error", () => {
    const home = tempHome();
    const tokenFile = path.join(home, "token");
    writeFileSync(tokenFile, "x".repeat(32), "utf8");
    expect(() =>
      loadHostConfig({
        homeDir: home,
        env: {
          STAGEFLOW_CONTROL_TOKEN: "y".repeat(32),
          STAGEFLOW_CONTROL_TOKEN_FILE: tokenFile,
        },
      }),
    ).toThrow(SecretFromEnvError);
  });

  it("redacted echo shows set/unset for secrets only", () => {
    const home = tempHome();
    const cfg = loadHostConfig({
      homeDir: home,
      env: { STAGEFLOW_CONTROL_TOKEN: "z".repeat(32) },
      configFilePath: null,
    });
    const echo = redactHostConfig(cfg);
    expect(echo.secrets).toEqual({
      controlToken: "set",
      readToken: "unset",
    });
    expect(JSON.stringify(echo)).not.toContain("z".repeat(8));
  });

  it("reads trust_workspace_config from file only", () => {
    const home = tempHome();
    mkdirSync(path.join(home, "proj"), { recursive: true });
    writeFileSync(
      path.join(home, "config.yaml"),
      "trust_workspace_config:\n  - /abs/proj\n",
      "utf8",
    );
    const cfg = loadHostConfig({ homeDir: home, env: {} });
    expect(cfg.trustWorkspaceConfig).toEqual(["/abs/proj"]);
  });

  describe("browser launch options", () => {
    const load = (yaml: string) => {
      const home = tempHome();
      writeFileSync(path.join(home, "config.yaml"), yaml, "utf8");
      return loadHostConfig({ env: {}, homeDir: home });
    };

    it("is off by default", () => {
      const c = loadHostConfig({ env: {}, homeDir: tempHome() });
      expect(c.browserLaunchArgs).toEqual([]);
      expect(c.browserExecutablePath).toBeUndefined();
    });

    it("accepts launch_args and an absolute executable_path", () => {
      const c = load(
        "browser:\n  launch_args:\n    - --no-sandbox\n    - --use-angle=swiftshader\n  executable_path: /usr/bin/chromium\n",
      );
      expect(c.browserLaunchArgs).toEqual(["--no-sandbox", "--use-angle=swiftshader"]);
      expect(c.browserExecutablePath).toBe("/usr/bin/chromium");
    });

    it("defaults dialog_timeout_seconds to 60 and accepts a positive integer", () => {
      expect(loadHostConfig({ env: {}, homeDir: tempHome() }).browserDialogTimeoutSeconds).toBe(60);
      expect(load("browser: {}\n").browserDialogTimeoutSeconds).toBe(60);
      expect(load("browser:\n  dialog_timeout_seconds: 30\n").browserDialogTimeoutSeconds).toBe(30);
    });

    it.each([
      ["zero", "0"],
      ["negative", "-5"],
      ["fraction", "1.5"],
      ["string", "'60'"],
    ])("rejects a %s dialog_timeout_seconds", (_name, value) => {
      expect(() => load(`browser:\n  dialog_timeout_seconds: ${value}\n`)).toThrow(HostConfigError);
    });

    it("accepts an empty list and an empty browser block", () => {
      expect(load("browser:\n  launch_args: []\n").browserLaunchArgs).toEqual([]);
      expect(load("browser: {}\n").browserExecutablePath).toBeUndefined();
    });

    it.each([
      ["string launch_args", "browser:\n  launch_args: --no-sandbox\n"],
      ["non-string item", "browser:\n  launch_args: [1]\n"],
      ["empty item", "browser:\n  launch_args: ['']\n"],
      ["comma in item", "browser:\n  launch_args: ['--a,--b']\n"],
      ["newline in item", "browser:\n  launch_args: [\"--a\\n--b\"]\n"],
      ["relative executable", "browser:\n  executable_path: chromium\n"],
      ["empty executable", "browser:\n  executable_path: ''\n"],
      ["non-string executable", "browser:\n  executable_path: 3\n"],
    ])("rejects %s", (_name, yaml) => {
      expect(() => load(yaml)).toThrow(HostConfigError);
    });

    it("still rejects unknown browser keys", () => {
      expect(() => load("browser:\n  display: ':1'\n")).toThrow(/Unknown key "display" under browser/);
    });
  });
});
