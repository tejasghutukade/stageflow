import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

  it("prefixes stderr with stage id", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-launcher-"));
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_STDERR: "worker-error",
        MOCK_DELAY: "10",
        MOCK_EXIT_CODE: "0",
      },
    });

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await launcher.launch({ runId: "r1", stageId: "stderr-stage", rootDir });

    expect(stderrSpy).toHaveBeenCalled();
    const combined = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .join("");
    expect(combined).toContain("[stage:stderr-stage] worker-error");

    stderrSpy.mockRestore();
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
});
