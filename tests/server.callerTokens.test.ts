import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import { writeAudit } from "../src/logging/audit.js";
import { loadHostConfig } from "../src/config/hostConfig.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  authenticateBearer,
  hasDriveToken,
  loadControlTokens,
} from "../src/server/controlToken.js";

const DEFAULT = "d".repeat(32);
const NAMED_A = "a".repeat(32);
const NAMED_B = "b".repeat(32);
const READ = "r".repeat(32);
const OTHER = "o".repeat(32);

describe("named control tokens", () => {
  it("maps plain token to caller_id default and named env to lowercased id", () => {
    const tokens = loadControlTokens({
      STAGEFLOW_CONTROL_TOKEN: DEFAULT,
      STAGEFLOW_CONTROL_TOKEN_CI_GITHUB: NAMED_A,
      STAGEFLOW_CONTROL_TOKEN_Alice: NAMED_B,
    });
    expect(authenticateBearer(tokens, `Bearer ${DEFAULT}`)).toEqual({
      scope: "drive",
      caller_id: "default",
    });
    expect(authenticateBearer(tokens, `Bearer ${NAMED_A}`)).toEqual({
      scope: "drive",
      caller_id: "ci_github",
    });
    expect(authenticateBearer(tokens, `Bearer ${NAMED_B}`)).toEqual({
      scope: "drive",
      caller_id: "alice",
    });
  });

  it("does not treat CONTROL_TOKEN_FILE as a named caller", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-named-tok-"));
    const file = path.join(dir, "token");
    await writeFile(file, `${DEFAULT}\n`, "utf8");
    const tokens = loadControlTokens({
      STAGEFLOW_CONTROL_TOKEN_FILE: file,
      STAGEFLOW_CONTROL_TOKEN_BOT: NAMED_A,
    });
    expect(hasDriveToken(tokens)).toBe(true);
    expect(authenticateBearer(tokens, `Bearer ${DEFAULT}`)).toEqual({
      scope: "drive",
      caller_id: "default",
    });
    expect(tokens.namedDrive.map((n) => n.caller_id).sort()).toEqual(["bot"]);
  });

  it("named tokens are drive-only; READ stays singular default", () => {
    const tokens = loadControlTokens({
      STAGEFLOW_CONTROL_TOKEN_TEAM: NAMED_A,
      STAGEFLOW_READ_TOKEN: READ,
    });
    expect(authenticateBearer(tokens, `Bearer ${NAMED_A}`)).toEqual({
      scope: "drive",
      caller_id: "team",
    });
    expect(authenticateBearer(tokens, `Bearer ${READ}`)).toEqual({
      scope: "read",
      caller_id: "default",
    });
  });

  it("compares all digests without early-return (no oracle on first match)", () => {
    const tokens = loadControlTokens({
      STAGEFLOW_CONTROL_TOKEN: DEFAULT,
      STAGEFLOW_CONTROL_TOKEN_CI: NAMED_A,
      STAGEFLOW_READ_TOKEN: READ,
    });
    expect(authenticateBearer(tokens, `Bearer ${NAMED_A}`)?.caller_id).toBe(
      "ci",
    );
    expect(authenticateBearer(tokens, `Bearer ${OTHER}`)).toBeUndefined();
    expect(authenticateBearer(tokens, `Bearer ${READ}`)?.scope).toBe("read");
  });

  it("rejects duplicate digests across default and named tokens", () => {
    expect(() =>
      loadControlTokens({
        STAGEFLOW_CONTROL_TOKEN: DEFAULT,
        STAGEFLOW_CONTROL_TOKEN_DUP: DEFAULT,
      }),
    ).toThrow(/Duplicate control token digests/);
  });

  it("allowlists STAGEFLOW_CONTROL_TOKEN_* in strict host config", () => {
    const home = path.join(tmpdir(), `sf-hc-${Date.now()}`);
    resetGlobalStageflowHomeForTests();
    expect(() =>
      loadHostConfig({
        homeDir: home,
        configFilePath: null,
        env: {
          STAGEFLOW_CONTROL_TOKEN_CI: NAMED_A,
        },
      }),
    ).not.toThrow();
  });

  it("loads callers quotas from config.yaml", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-callers-"));
    await writeFile(
      path.join(dir, "config.yaml"),
      "callers:\n  ci_github:\n    max_concurrent: 2\n  default:\n    max_concurrent: 1\n",
      "utf8",
    );
    const cfg = loadHostConfig({
      homeDir: dir,
      env: {},
    });
    expect(cfg.callers).toEqual({
      ci_github: { maxConcurrent: 2 },
      default: { maxConcurrent: 1 },
    });
  });

  it("audit allowlist never includes Authorization or pipeline_body", () => {
    const lines: string[] = [];
    const log = createLogger({
      format: "json",
      level: "info",
      write: (line) => {
        lines.push(line);
      },
    });
    writeAudit(log, {
      caller_id: "ci_github",
      surface: "mcp",
      action: "start_run",
      target_run_id: "run-1",
      outcome: "ok",
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.event).toBe("audit");
    expect(record.caller_id).toBe("ci_github");
    expect(record.surface).toBe("mcp");
    expect(record.action).toBe("start_run");
    expect(record.target_run_id).toBe("run-1");
    expect(record.outcome).toBe("ok");
    expect(record.Authorization).toBeUndefined();
    expect(record.pipeline_body).toBeUndefined();
    expect(record.skills).toBeUndefined();
  });
});
