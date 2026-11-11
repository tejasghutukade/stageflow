import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { createLogger } from "../src/logging/logger.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

const mockWorker = fileURLToPath(
  new URL("./fixtures/mockStageWorker.mjs", import.meta.url),
);

describe("StageProcessLauncher", () => {
  it("loads a TypeScript cli entry with the tsx loader", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-tsx-"));
    const calls: Array<{ modulePath: string; execArgv?: string[] }> = [];
    const launcher = new StageProcessLauncher({
      cliEntry: path.join(rootDir, "cli.ts"),
      forkFn: ((modulePath, _args, options) => {
        calls.push({ modulePath, execArgv: options?.execArgv });
        const child = new EventEmitter() as ChildProcess;
        child.stdout = null;
        child.stderr = null;
        child.pid = 42;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }) as typeof childProcess.fork,
    });

    await expect(
      launcher.launch({ runId: "r-tsx", stageId: "s", rootDir }),
    ).resolves.toEqual({ type: "succeeded" });

    expect(calls).toEqual([
      {
        modulePath: path.join(rootDir, "cli.ts"),
        execArgv: [
          expect.stringMatching(/^--max-old-space-size=/),
          "--require",
          fileURLToPath(import.meta.resolve("tsx/preflight")),
          "--import",
          import.meta.resolve("tsx"),
        ],
      },
    ]);
  });

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

  it("gives host CURSOR_API_KEY only to a cursor stage", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-cursor-key-"));
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const previous = {
      key: process.env.CURSOR_API_KEY,
      allow: process.env.STAGEFLOW_STAGE_ENV_ALLOW,
      passthrough: process.env.STAGEFLOW_STAGE_ENV_PASSTHROUGH,
    };
    process.env.CURSOR_API_KEY = "test-cursor-key";
    delete process.env.STAGEFLOW_STAGE_ENV_ALLOW;
    delete process.env.STAGEFLOW_STAGE_ENV_PASSTHROUGH;
    const launcher = new StageProcessLauncher({
      cliEntry: mockWorker,
      forkFn: ((...args: Parameters<typeof childProcess.fork>) => {
        envs.push(args[2]?.env);
        const child = new EventEmitter() as ChildProcess;
        child.stdout = null;
        child.stderr = null;
        child.pid = 42;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }) as typeof childProcess.fork,
    });

    try {
      await launcher.launch({
        runId: "r-cursor",
        stageId: "draft",
        rootDir,
        model: "cursor/composer-2-5",
      });
      await launcher.launch({
        runId: "r-other",
        stageId: "other",
        rootDir,
        model: "anthropic/claude-sonnet-4-5",
      });
    } finally {
      if (previous.key === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous.key;
      if (previous.allow === undefined) delete process.env.STAGEFLOW_STAGE_ENV_ALLOW;
      else process.env.STAGEFLOW_STAGE_ENV_ALLOW = previous.allow;
      if (previous.passthrough === undefined) {
        delete process.env.STAGEFLOW_STAGE_ENV_PASSTHROUGH;
      } else {
        process.env.STAGEFLOW_STAGE_ENV_PASSTHROUGH = previous.passthrough;
      }
    }

    expect(envs[0]?.CURSOR_API_KEY).toBe("test-cursor-key");
    expect(envs[1]?.CURSOR_API_KEY).toBeUndefined();
  });

  it("resolves after-phase completion grants on the host", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-fn-after-"));
    const sent: unknown[] = [];
    const grantsSeen: Array<unknown> = [];
    const child = new EventEmitter() as ChildProcess;
    child.stdout = null;
    child.stderr = null;
    child.connected = true;
    child.pid = 44;
    child.kill = (() => true) as ChildProcess["kill"];
    child.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as ChildProcess["send"];
    const launcher = new StageProcessLauncher({
      cliEntry: "unused",
      functionInvoker: {
        async call(_projectRoot, input) {
          grantsSeen.push(input.grants);
          return {
            ok: true,
            value: { passed: true },
            logs: "",
            durationMs: 1,
            sourceHash: "hash",
            revision: 1,
            kind: "verification",
            status: "succeeded",
          };
        },
        async cancel() {},
      },
      forkFn: (() => {
        queueMicrotask(() => {
          child.emit("message", {
            type: "function.invoke",
            requestId: "req-after",
            input: {
              functionId: "score_check",
              kind: "verification",
              attachmentId: "after-score",
              input: { execution: { phase: "after" } },
            },
          });
        });
        return child;
      }) as typeof childProcess.fork,
    });

    const pending = launcher.launch({
      runId: "r-fn-after",
      stageId: "check",
      rootDir,
      factoryCwd: "/projects/app",
      stage: { id: "check", system_prompt: "x" },
      completion: {
        mode: "all",
        checks: [
          {
            id: "after-score",
            type: "function",
            function: "score_check",
            grants: [{ id: "files.read", roots: ["."] }],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(grantsSeen).toEqual([[{ id: "files.read", roots: ["."] }]]);
    child.emit("message", { type: "succeeded" });
    await expect(pending).resolves.toEqual({ type: "succeeded" });
  });

  it("resolves check-scoped emit grants by attachmentId", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-fn-scope-"));
    const sent: unknown[] = [];
    const grantsSeen: Array<unknown> = [];
    const child = new EventEmitter() as ChildProcess;
    child.stdout = null;
    child.stderr = null;
    child.connected = true;
    child.pid = 45;
    child.kill = (() => true) as ChildProcess["kill"];
    child.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as ChildProcess["send"];
    const launcher = new StageProcessLauncher({
      cliEntry: "unused",
      functionInvoker: {
        async call(_projectRoot, input) {
          grantsSeen.push(input.grants);
          return {
            ok: true,
            value: { passed: true },
            logs: "",
            durationMs: 1,
            sourceHash: "hash",
            revision: 1,
            kind: "verification",
            status: "succeeded",
          };
        },
        async cancel() {},
      },
      forkFn: (() => {
        queueMicrotask(() => {
          child.emit("message", {
            type: "function.invoke",
            requestId: "req-scope",
            input: {
              functionId: "score_check",
              kind: "verification",
              attachmentId: "narrow",
              input: { execution: { phase: "emit" } },
            },
          });
        });
        return child;
      }) as typeof childProcess.fork,
    });

    const pending = launcher.launch({
      runId: "r-fn-scope",
      stageId: "check",
      rootDir,
      stage: {
        id: "check",
        system_prompt: "x",
        pre_emit_checks: [
          {
            id: "broad",
            type: "function",
            function: "score_check",
            grants: [{ id: "env", keys: ["SECRET"] }],
          },
          {
            id: "narrow",
            type: "function",
            function: "score_check",
            grants: [{ id: "files.read", roots: ["out"] }],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(grantsSeen).toEqual([[{ id: "files.read", roots: ["out"] }]]);
    child.emit("message", { type: "succeeded" });
    await expect(pending).resolves.toEqual({ type: "succeeded" });
  });

  it("runs a function call on the host and keeps the worker result", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-fn-ipc-"));
    const sent: unknown[] = [];
    const calls: Array<{ projectRoot: string; invocationId?: string }> = [];
    const child = new EventEmitter() as ChildProcess;
    child.stdout = null;
    child.stderr = null;
    child.connected = true;
    child.pid = 42;
    child.kill = (() => true) as ChildProcess["kill"];
    child.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as ChildProcess["send"];
    const launcher = new StageProcessLauncher({
      cliEntry: "unused",
      functionInvoker: {
        async call(projectRoot, input) {
          calls.push({ projectRoot, invocationId: input.invocationId });
          return {
            ok: true,
            value: { passed: true },
            logs: "",
            durationMs: 1,
            sourceHash: "hash",
            revision: 1,
            kind: "verification",
            status: "succeeded",
          };
        },
        async cancel() {},
      },
      forkFn: (() => {
        queueMicrotask(() => {
          child.emit("message", {
            type: "function.invoke",
            requestId: "req-1",
            input: { functionId: "score_check", kind: "verification", projectRoot: "/tmp/other" },
          });
        });
        return child;
      }) as typeof childProcess.fork,
    });

    const pending = launcher.launch({
      runId: "r-fn",
      stageId: "check",
      rootDir,
      factoryCwd: "/projects/app",
      stage: {
        id: "check",
        system_prompt: "x",
        pre_emit_checks: [{ id: "score", type: "function", function: "score_check", grants: [] }],
      },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(calls).toEqual([{ projectRoot: "/projects/app", invocationId: "req-1" }]);
    expect(sent[0]).toMatchObject({
      type: "function.response",
      requestId: "req-1",
      view: { ok: true, value: { passed: true } },
    });
    child.emit("message", { type: "succeeded" });
    await expect(pending).resolves.toEqual({ type: "succeeded" });
  });

  it("cancels an in-flight function call when the stage worker exits", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "sf-stage-fn-cancel-"));
    let started = false;
    let release: (view: {
      ok: false;
      code: string;
      message: string;
      logs: string;
      durationMs: number;
      sourceHash: string;
      revision: null;
      kind: "verification";
      status: "failed";
    }) => void = () => {};
    const cancelled: string[] = [];
    const child = new EventEmitter() as ChildProcess;
    child.stdout = null;
    child.stderr = null;
    child.connected = true;
    child.pid = 43;
    child.kill = (() => true) as ChildProcess["kill"];
    child.send = (() => true) as ChildProcess["send"];
    const launcher = new StageProcessLauncher({
      cliEntry: "unused",
      functionInvoker: {
        call() {
          started = true;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        async cancel(invocationId) {
          cancelled.push(invocationId);
          release({
            ok: false,
            code: "cancelled",
            message: "function execution cancelled",
            logs: "",
            durationMs: 0,
            sourceHash: "",
            revision: null,
            kind: "verification",
            status: "failed",
          });
        },
      },
      forkFn: (() => {
        queueMicrotask(() => {
          child.emit("message", {
            type: "function.invoke",
            requestId: "req-exit",
            input: { functionId: "score_check", kind: "verification" },
          });
        });
        return child;
      }) as typeof childProcess.fork,
    });

    const pending = launcher.launch({
      runId: "r-fn",
      stageId: "check",
      rootDir,
      stage: {
        id: "check",
        system_prompt: "x",
        pre_emit_checks: [{ id: "score", type: "function", function: "score_check", grants: [] }],
      },
    });
    await vi.waitFor(() => expect(started).toBe(true));
    child.emit("exit", null, "SIGTERM");
    await expect(pending).resolves.toEqual({
      type: "failed",
      reason: "stage process exited (SIGTERM)",
    });
    expect(cancelled).toEqual(["req-exit"]);
  });
});
