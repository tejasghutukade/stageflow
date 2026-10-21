import { afterEach, describe, expect, it } from "vitest";
import {
  createLogger,
  resolveLogFormat,
  resolveLogLevel,
  resolveLogMaxLineBytes,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_MAX_LINE_BYTES,
} from "../src/logging/logger.js";

describe("resolveLogFormat / resolveLogLevel", () => {
  it("defaults to pretty on TTY and json otherwise", () => {
    expect(resolveLogFormat({}, true)).toBe("pretty");
    expect(resolveLogFormat({}, false)).toBe("json");
  });

  it("honours STAGEFLOW_LOG_FORMAT override", () => {
    expect(
      resolveLogFormat({ STAGEFLOW_LOG_FORMAT: "json" }, true),
    ).toBe("json");
    expect(
      resolveLogFormat({ STAGEFLOW_LOG_FORMAT: "pretty" }, false),
    ).toBe("pretty");
  });

  it("defaults level to info and accepts STAGEFLOW_LOG_LEVEL", () => {
    expect(resolveLogLevel({})).toBe(DEFAULT_LOG_LEVEL);
    expect(resolveLogLevel({ STAGEFLOW_LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveLogLevel({ STAGEFLOW_LOG_LEVEL: "warn" })).toBe("warn");
    expect(resolveLogLevel({ STAGEFLOW_LOG_LEVEL: "nope" })).toBe("info");
  });

  it("defaults max line bytes to 8192", () => {
    expect(resolveLogMaxLineBytes({})).toBe(DEFAULT_LOG_MAX_LINE_BYTES);
    expect(
      resolveLogMaxLineBytes({ STAGEFLOW_LOG_MAX_LINE_BYTES: "4096" }),
    ).toBe(4096);
  });
});

describe("createLogger", () => {
  const lines: string[] = [];
  const write = (line: string) => {
    lines.push(line);
  };

  afterEach(() => {
    lines.length = 0;
  });

  it("AE15: piped stdout emits JSON lines with ts, level, event, msg", () => {
    const log = createLogger({
      format: "json",
      level: "info",
      write,
      bindings: { component: "host" },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    log.info("host.listening", "listening on http://127.0.0.1:3847");

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      ts: "2026-09-22T12:00:00.000Z",
      level: "info",
      event: "host.listening",
      msg: "listening on http://127.0.0.1:3847",
      component: "host",
    });
  });

  it("AE16: child logger includes run_id, stage_id, attempt", () => {
    const log = createLogger({
      format: "json",
      write,
      bindings: { component: "runtime" },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    log
      .child({ run_id: "run_1", stage_id: "implement", attempt: 2 })
      .info("stage.interrupted", "stage interrupted by host shutdown");

    const record = JSON.parse(lines[0]!);
    expect(record.run_id).toBe("run_1");
    expect(record.stage_id).toBe("implement");
    expect(record.attempt).toBe(2);
    expect(record.component).toBe("runtime");
  });

  it("AE17: STAGEFLOW_LOG_FORMAT=pretty emits non-JSON human lines", () => {
    const log = createLogger({
      env: { STAGEFLOW_LOG_FORMAT: "pretty" },
      stdoutIsTTY: false,
      write,
      bindings: { component: "runtime" },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    log
      .child({ run_id: "run_1", stage_id: "implement", attempt: 1 })
      .info("reconcile.complete", "reconciled 1 orphaned stage(s)");

    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).toThrow();
    expect(lines[0]).toContain("INFO");
    expect(lines[0]).toContain("[runtime]");
    expect(lines[0]).toContain("reconcile.complete:");
    expect(lines[0]).toContain("run_id=run_1");
    expect(lines[0]).toContain("stage_id=implement");
    expect(lines[0]).toContain("attempt=1");
  });

  it("AE18: known secret in msg is redacted without call-site cooperation", () => {
    const secret = "super-secret-token-value-xyz";
    const log = createLogger({
      format: "json",
      write,
      knownSecrets: [secret],
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    log.info("leak.check", `token was ${secret}`);

    const record = JSON.parse(lines[0]!);
    expect(record.msg).toBe("token was [redacted]");
    expect(lines[0]).not.toContain(secret);
  });

  it("redacts pattern-shaped secrets in msg", () => {
    const log = createLogger({
      format: "json",
      write,
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    log.info("auth", "using sk-abcdefghijklmnopqrstuvwxyz123456");

    const record = JSON.parse(lines[0]!);
    expect(record.msg).toBe("using [redacted]");
  });

  it("oversize line sets truncated true", () => {
    const maxLineBytes = 200;
    const log = createLogger({
      format: "json",
      write,
      maxLineBytes,
      bindings: { component: "runtime" },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    const big = "x".repeat(500);
    log.info("overflow", big);

    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!, "utf8")).toBeLessThanOrEqual(
      maxLineBytes,
    );
    const record = JSON.parse(lines[0]!);
    expect(record.truncated).toBe(true);
    expect(record.original_bytes).toBeGreaterThan(maxLineBytes);
    expect(record.msg.length).toBeLessThan(big.length);
  });

  it("filters below configured level", () => {
    const log = createLogger({
      format: "json",
      level: "warn",
      write,
    });
    log.info("skip", "should not appear");
    log.warn("keep", "should appear");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe("keep");
  });
});
