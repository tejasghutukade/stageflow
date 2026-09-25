import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  signalProcessGroup,
  StageProcessLauncher,
} from "../src/runtime/stageProcessLauncher.js";

const mockWorker = fileURLToPath(
  new URL("./fixtures/mockStageWorker.mjs", import.meta.url),
);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("process-group kill", () => {
  it("SIGKILLs a worker that ignores SIGTERM after killAfterMs", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-pg-ignore-"));
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_IGNORE_SIGTERM: "1",
        MOCK_DELAY: "60000",
      },
    });

    const launchPromise = launcher.launch({
      runId: "run-ignore",
      stageId: "wedged",
      rootDir,
    });

    await vi.waitFor(() => expect(launcher.activeCount()).toBe(1), {
      timeout: 2000,
    });

    const cancelPromise = launcher.cancelRun("run-ignore", 150);
    await expect(cancelPromise).resolves.toBeUndefined();
    const result = await launchPromise;
    expect(result.type).toBe("failed");
    expect(launcher.activeCount()).toBe(0);
  });

  it("kills a sleeping grandchild when cancelling the worker group", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-pg-gc-"));
    const pidFile = path.join(rootDir, "grandchild.pid");
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_GRANDCHILD_PID_FILE: pidFile,
        MOCK_IGNORE_SIGTERM: "1",
        MOCK_DELAY: "60000",
      },
    });

    const launchPromise = launcher.launch({
      runId: "run-gc",
      stageId: "parent",
      rootDir,
    });

    await vi.waitFor(
      async () => {
        const raw = await readFile(pidFile, "utf8");
        expect(Number(raw)).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    expect(pidAlive(grandchildPid)).toBe(true);

    await launcher.cancelRun("run-gc", 150);
    await launchPromise;

    await vi.waitFor(() => expect(pidAlive(grandchildPid)).toBe(false), {
      timeout: 2000,
    });
  });

  it("reaps SIGTERM-proof grandchild after cooperative parent exit", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-pg-gc-coop-"));
    const pidFile = path.join(rootDir, "grandchild.pid");
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: {
        MOCK_GRANDCHILD_PID_FILE: pidFile,
        MOCK_DELAY: "60000",
      },
    });

    const launchPromise = launcher.launch({
      runId: "run-gc-coop",
      stageId: "parent",
      rootDir,
    });

    await vi.waitFor(
      async () => {
        const raw = await readFile(pidFile, "utf8");
        expect(Number(raw)).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    expect(pidAlive(grandchildPid)).toBe(true);

    await launcher.cancelRun("run-gc-coop", 150);
    await launchPromise;

    await vi.waitFor(() => expect(pidAlive(grandchildPid)).toBe(false), {
      timeout: 2000,
    });
  });

  it("cooperative worker exits on SIGTERM and SIGKILLs the process group", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-pg-coop-"));
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      env: { MOCK_DELAY: "60000" },
    });

    const kills: Array<{ pid: number; signal: string }> = [];
    const originalKill = process.kill.bind(process);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        kills.push({ pid, signal: String(signal ?? "") });
        return originalKill(pid, signal);
      }) as typeof process.kill);

    const launchPromise = launcher.launch({
      runId: "run-coop",
      stageId: "slow",
      rootDir,
    });

    await vi.waitFor(() => expect(launcher.activeCount()).toBe(1), {
      timeout: 2000,
    });

    await launcher.cancelRun("run-coop", 2000);
    await launchPromise;

    killSpy.mockRestore();
    expect(kills.some((k) => k.signal === "SIGKILL" && k.pid < 0)).toBe(true);
    expect(kills.some((k) => k.signal === "SIGTERM" && k.pid < 0)).toBe(true);
  });

  it("signalProcessGroup tolerates undefined pid and already-exited groups", () => {
    expect(() => signalProcessGroup(undefined, "SIGTERM")).not.toThrow();

    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = exited.pid;
    expect(pid).toBeTypeOf("number");
    expect(() => signalProcessGroup(pid, "SIGTERM")).not.toThrow();
    expect(() => signalProcessGroup(pid, "SIGKILL")).not.toThrow();
  });
});
