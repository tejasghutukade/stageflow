import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logging/logger.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

const mockWorker = fileURLToPath(
  new URL("./fixtures/mockStageWorker.mjs", import.meta.url),
);

describe("StageProcessLauncher", () => {
  it("cap of 2 blocks third until one completes", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-launcher-"));
    const launcher = new StageProcessLauncher({
      maxActiveStageProcesses: 2,
      cliEntry: mockWorker,
    });

    const p1 = launcher.launch({ runId: "r1", stageId: "a", rootDir });
    const p2 = launcher.launch({ runId: "r1", stageId: "b", rootDir });
    const p3 = launcher.launch({ runId: "r1", stageId: "c", rootDir });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(launcher.activeCount()).toBe(2);
    expect(
      launcher
        .getActiveStageProcesses()
        .map((entry) => entry.stageId)
        .sort(),
    ).toEqual(["a", "b"]);

    const r1 = await p1;
    expect(r1).toEqual({ type: "succeeded" });

    await vi.waitFor(
      () => {
        expect(
          launcher.getActiveStageProcesses().some((e) => e.stageId === "c"),
        ).toBe(true);
      },
      { timeout: 2000 },
    );

    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2).toEqual({ type: "succeeded" });
    expect(r3).toEqual({ type: "succeeded" });
    expect(launcher.activeCount()).toBe(0);
  });

  it("cancelRun sends signal and resolves", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-launcher-"));
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
    });

    const launchPromise = launcher.launch({
      runId: "run-cancel",
      stageId: "slow",
      rootDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launcher.activeCount()).toBe(1);

    await launcher.cancelRun("run-cancel", 100);
    const result = await launchPromise;
    expect(result.type).toBe("failed");
    expect(launcher.activeCount()).toBe(0);
  });

  it("cancelRun escalates to SIGKILL when worker ignores SIGTERM", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-escalate-"));
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_IGNORE_SIGTERM: "1",
        MOCK_DELAY: "60000",
      },
    });

    const launchPromise = launcher.launch({
      runId: "run-escalate",
      stageId: "wedged",
      rootDir,
    });

    await vi.waitFor(() => expect(launcher.activeCount()).toBe(1), {
      timeout: 2000,
    });

    await expect(launcher.cancelRun("run-escalate", 100)).resolves.toBeUndefined();
    await launchPromise;
    expect(launcher.activeCount()).toBe(0);
  });

  it("emits stderr as structured stage.stderr events", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-launcher-"));
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
        MOCK_STDERR: "worker-error",
        MOCK_DELAY: "10",
        MOCK_EXIT_CODE: "0",
      },
    });

    await launcher.launch({ runId: "r1", stageId: "stderr-stage", rootDir });

    const stderr = lines
      .map((line) => JSON.parse(line))
      .filter((r) => r.event === "stage.stderr");
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatchObject({
      event: "stage.stderr",
      msg: "worker-error",
      run_id: "r1",
      stage_id: "stderr-stage",
    });
  });

  it("holds two clone instance ids as distinct activeKeys", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-clone-keys-"));
    const launcher = new StageProcessLauncher({
      maxActiveStageProcesses: 2,
      cliEntry: mockWorker,
      env: { MOCK_DELAY: "250" },
    });

    const p1 = launcher.launch({
      runId: "r1",
      stageId: "author-diagrams~1",
      rootDir,
    });
    const p2 = launcher.launch({
      runId: "r1",
      stageId: "author-diagrams~2",
      rootDir,
    });

    await vi.waitFor(
      () => {
        expect(
          launcher
            .getActiveStageProcesses()
            .map((e) => e.stageId)
            .sort(),
        ).toEqual(["author-diagrams~1", "author-diagrams~2"]);
      },
      { timeout: 2000 },
    );

    await Promise.all([p1, p2]);
    expect(launcher.activeCount()).toBe(0);
  });

  it("releases capacity when fork throws before child exit cleanup", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-fork-throw-"));
    const childProcess = await import("node:child_process");
    let shouldThrow = true;
    const launcher = new StageProcessLauncher({
      maxActiveStageProcesses: 1,
      cliEntry: mockWorker,
      env: { MOCK_DELAY: "50" },
      forkFn: ((...args: Parameters<typeof childProcess.fork>) => {
        if (shouldThrow) {
          throw new Error("fork failed");
        }
        return childProcess.fork(...args);
      }) as typeof childProcess.fork,
    });

    await expect(
      launcher.launch({ runId: "r-fork", stageId: "boom", rootDir }),
    ).rejects.toThrow("fork failed");

    shouldThrow = false;
    const recovered = await launcher.launch({
      runId: "r-fork",
      stageId: "ok",
      rootDir,
    });
    expect(recovered).toEqual({ type: "succeeded" });
    expect(launcher.activeCount()).toBe(0);
  });

  it("cancelRun drains queued waiters so they do not fork", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-cancel-queue-"));
    const launcher = new StageProcessLauncher({
      maxActiveStageProcesses: 1,
      cliEntry: mockWorker,
      env: { MOCK_DELAY: "400" },
    });

    const holding = launcher.launch({
      runId: "run-hold",
      stageId: "holder",
      rootDir,
    });
    await vi.waitFor(() => expect(launcher.activeCount()).toBe(1), {
      timeout: 2000,
    });

    const queued = launcher.launch({
      runId: "run-queued",
      stageId: "queued",
      rootDir,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      launcher.getActiveStageProcesses().some((e) => e.stageId === "queued"),
    ).toBe(false);

    await launcher.cancelRun("run-queued", 50);
    const queuedResult = await queued;
    expect(queuedResult).toEqual({ type: "failed", reason: "cancelled" });
    expect(
      launcher.getActiveStageProcesses().some((e) => e.stageId === "queued"),
    ).toBe(false);

    await holding;
    expect(launcher.activeCount()).toBe(0);

    const after = await launcher.launch({
      runId: "run-after",
      stageId: "after",
      rootDir,
    });
    expect(after).toEqual({ type: "succeeded" });
  });
});
