import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logging/logger.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

const mockWorker = fileURLToPath(
  new URL("./fixtures/mockStageWorker.mjs", import.meta.url),
);

const FLOOD_TEST_TIMEOUT_MS = 3000;

describe("StageProcessLauncher stream drain", () => {
  it(
    "AE22: worker writing >1 MB to stdout settles within timeout",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stdout-flood-"));
      const lines: string[] = [];
      const launcher = new StageProcessLauncher({
        cliEntry: mockWorker,
        logger: createLogger({
          format: "json",
          write: (line) => {
            lines.push(line);
          },
        }),
        env: {
          MOCK_STDOUT_BYTES: String(1.5 * 1024 * 1024),
          MOCK_DELAY: "10",
          MOCK_EXIT_CODE: "0",
        },
      });

      const result = await launcher.launch({
        runId: "run-flood",
        stageId: "flood",
        rootDir,
      });

      expect(result).toEqual({ type: "succeeded" });
      expect(launcher.activeCount()).toBe(0);
      expect(
        lines.some((line) => {
          try {
            return JSON.parse(line).event === "stage.stdout";
          } catch {
            return false;
          }
        }),
      ).toBe(true);
    },
    FLOOD_TEST_TIMEOUT_MS,
  );

  it("emits structured stage.stdout and stage.stderr events in json format", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stdout-struct-"));
    const lines: string[] = [];
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      logger: createLogger({
        format: "json",
        write: (line) => {
          lines.push(line);
        },
        now: () => new Date("2026-09-22T12:00:00.000Z"),
      }),
      env: {
        MOCK_STDOUT: "out-one\nout-two",
        MOCK_STDERR: "err-one\nerr-two",
        MOCK_DELAY: "10",
        MOCK_EXIT_CODE: "0",
      },
    });

    await launcher.launch({
      runId: "run-struct",
      stageId: "stream-stage",
      attempt: 3,
      rootDir,
    });

    const records = lines.map((line) => JSON.parse(line));
    const stdout = records.filter((r) => r.event === "stage.stdout");
    const stderr = records.filter((r) => r.event === "stage.stderr");

    expect(stdout.map((r) => r.msg)).toEqual(["out-one", "out-two"]);
    expect(stderr.map((r) => r.msg)).toEqual(["err-one", "err-two"]);

    for (const record of [...stdout, ...stderr]) {
      expect(record).toMatchObject({
        ts: "2026-09-22T12:00:00.000Z",
        level: "info",
        run_id: "run-struct",
        stage_id: "stream-stage",
        attempt: 3,
      });
    }
  });

  it("emits a partial final line once on stream end", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stdout-partial-"));
    const lines: string[] = [];
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      logger: createLogger({
        format: "json",
        write: (line) => {
          lines.push(line);
        },
      }),
      env: {
        MOCK_STDOUT: "complete\npartial-tail",
        MOCK_STDOUT_PARTIAL: "1",
        MOCK_DELAY: "10",
        MOCK_EXIT_CODE: "0",
      },
    });

    await launcher.launch({
      runId: "run-partial",
      stageId: "partial",
      rootDir,
    });

    const stdoutMsgs = lines
      .map((line) => JSON.parse(line))
      .filter((r) => r.event === "stage.stdout")
      .map((r) => r.msg);

    expect(stdoutMsgs).toEqual(["complete", "partial-tail"]);
    expect(stdoutMsgs.filter((msg) => msg === "partial-tail")).toHaveLength(1);
  });

  it("caps newline-free stdout and emits truncated events", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stdout-nolf-"));
    const maxLineBytes = 1024;
    const floodBytes = 50 * 1024;
    const lines: string[] = [];
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      logger: createLogger({
        format: "json",
        maxLineBytes,
        write: (line) => {
          lines.push(line);
        },
      }),
      env: {
        MOCK_STDOUT_BYTES: String(floodBytes),
        MOCK_DELAY: "10",
        MOCK_EXIT_CODE: "0",
        STAGEFLOW_LOG_MAX_LINE_BYTES: String(maxLineBytes),
      },
    });

    const result = await launcher.launch({
      runId: "run-nolf",
      stageId: "nolf",
      rootDir,
    });

    expect(result).toEqual({ type: "succeeded" });

    const stdout = lines
      .map((line) => JSON.parse(line))
      .filter((r) => r.event === "stage.stdout");

    expect(stdout.length).toBeGreaterThan(1);
    expect(stdout.some((r) => r.truncated === true)).toBe(true);
    for (const record of stdout) {
      expect(Buffer.byteLength(record.msg, "utf8")).toBeLessThanOrEqual(
        maxLineBytes,
      );
    }
  });
});
