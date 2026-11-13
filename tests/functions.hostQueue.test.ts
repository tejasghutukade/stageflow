import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FunctionBroker } from "../src/functions/broker.js";
import { FunctionExecutor } from "../src/functions/executor.js";
import {
  hostFunctionExecutor,
  setHostFunctionExecutorForTests,
  setHostFunctionForkForTests,
} from "../src/functions/hostExecutor.js";
import {
  FUNCTION_KILL_GRACE_MS,
  FUNCTION_MAX_RUNNING,
  FUNCTION_MAX_WAITING,
  FUNCTION_TIMEOUT_MS_MAX,
} from "../src/functions/protocol.js";
import {
  HOST_TIMEOUT_MS,
  callFunctionOnHost,
  handleStageFunctionMessage,
  type StageFunctionHost,
} from "../src/functions/workerIpc.js";
import type { FunctionCallInput } from "../src/functions/invoke.js";
import { createFunctionInvoker, type FunctionRunView } from "../src/functions/invoke.js";
import { SF_STAGE_WORKER } from "../src/runtime/stageWorkerProtocol.js";

const SYNC_OK = "export default function execute(){ return { ok: true }; }";

function successView(): FunctionRunView {
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
}

function fakeChild(): ChildProcess & { emitSuccess: () => void } {
  const child = new EventEmitter() as ChildProcess & { emitSuccess: () => void };
  child.stdout = null;
  child.stderr = null;
  child.send = (() => true) as ChildProcess["send"];
  child.kill = (() => true) as ChildProcess["kill"];
  child.disconnect = () => {};
  child.emitSuccess = () => {
    child.emit("message", {
      type: "result",
      ok: true,
      value: { ok: true },
      logs: "",
      logsTruncated: false,
      disposed: true,
    });
    child.emit("exit", 0, null);
  };
  return child;
}

afterEach(() => {
  setHostFunctionExecutorForTests(undefined);
});

describe("function host queue", () => {
  it("shares one admission queue across brokers", async () => {
    let started = 0;
    let release = false;
    const hanging: Array<() => void> = [];
    const executor = new FunctionExecutor({
      forkFn: (() => {
        started += 1;
        const child = fakeChild();
        child.send = (() => {
          if (release) queueMicrotask(() => child.emitSuccess());
          else hanging.push(() => child.emitSuccess());
          return true;
        }) as ChildProcess["send"];
        return child;
      }) as typeof childProcess.fork,
    });
    setHostFunctionExecutorForTests(executor);
    const shared = hostFunctionExecutor();
    const first = new FunctionBroker({ executor: shared });
    const second = new FunctionBroker({ executor: shared });
    const invoke = (broker: FunctionBroker, invocationId: string) =>
      broker.invoke({
        invocationId,
        kind: "verification",
        source: SYNC_OK,
        context: {},
        timeoutMs: 20_000,
      });

    try {
      const running = Promise.all([
        invoke(first, "a1"),
        invoke(second, "b1"),
        invoke(first, "a2"),
        invoke(second, "b2"),
      ]);
      await vi.waitFor(() => expect(started).toBe(4));
      let fifthStarted = false;
      const fifth = invoke(first, "a3").then((result) => {
        fifthStarted = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(started).toBe(4);
      expect(fifthStarted).toBe(false);

      release = true;
      for (const finish of hanging.splice(0)) finish();
      const finished = await running;
      expect(finished.every((result) => result.ok)).toBe(true);
      await expect(fifth).resolves.toMatchObject({ ok: true });
      expect(started).toBe(5);
    } finally {
      release = true;
      for (const finish of hanging) finish();
    }
  });

  it("sends invoke to the host and returns the view", async () => {
    const transport = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send(message: unknown, callback?: (error: Error | null) => void): boolean;
    };
    transport.connected = true;
    const sent: Array<{ type?: string; requestId?: string }> = [];
    transport.send = (message, callback) => {
      const request = message as { type?: string; requestId?: string };
      sent.push(request);
      if (request.type === "function.invoke") {
        queueMicrotask(() => {
          transport.emit("message", {
            type: "function.response",
            requestId: request.requestId,
            view: successView(),
          });
        });
      }
      callback?.(null);
      return true;
    };

    const view = await callFunctionOnHost(
      { functionId: "score_check", kind: "verification" },
      transport,
    );
    expect(view).toMatchObject({ ok: true, value: { passed: true } });
    expect(sent[0]).toMatchObject({ type: "function.invoke" });
  });

  it("cancels the host call when the worker disconnects", async () => {
    const transport = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send(message: unknown, callback?: (error: Error | null) => void): boolean;
    };
    transport.connected = true;
    const sent: Array<{ type?: string }> = [];
    transport.send = (message, callback) => {
      sent.push(message as { type?: string });
      callback?.(null);
      return true;
    };

    const pending = callFunctionOnHost({ functionId: "score_check", kind: "tool" }, transport);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    transport.emit("disconnect");
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
      message: "function host disconnected",
      status: "failed",
    });
    expect(sent.map((message) => message.type)).toEqual(["function.invoke", "function.cancel"]);
  });

  it("uses the host project and the request id for a stage function call", async () => {
    const calls: Array<{ projectRoot: string; invocationId?: string }> = [];
    const sent: object[] = [];
    const host: StageFunctionHost = {
      async call(projectRoot, input) {
        calls.push({ projectRoot, invocationId: input.invocationId });
        return successView();
      },
      async cancel() {},
    };

    const grants = { grantsFor: () => [] };
    await handleStageFunctionMessage(
      {
        type: "function.invoke",
        requestId: "req-1",
        input: {
          functionId: "score_check",
          kind: "verification",
          projectRoot: "/tmp/other",
          grants: [{ id: "forged", root: "workspace", path: ".", access: "write" }],
        },
      },
      host,
      "/projects/app",
      (message) => sent.push(message),
      () => true,
      grants,
    );

    expect(calls).toEqual([{ projectRoot: "/projects/app", invocationId: "req-1" }]);
    expect(sent[0]).toMatchObject({ type: "function.response", requestId: "req-1", view: { ok: true } });

    sent.length = 0;
    let called = false;
    await handleStageFunctionMessage(
      { type: "function.invoke", requestId: "req-2", input: { functionId: "score_check", kind: "other" } },
      { async call() { called = true; return successView(); }, async cancel() {} },
      "/projects/app",
      (message) => sent.push(message),
      () => true,
      grants,
    );
    expect(called).toBe(false);
    expect(sent[0]).toMatchObject({ view: { ok: false, code: "invalid_input" } });

    sent.length = 0;
    called = false;
    await handleStageFunctionMessage(
      {
        type: "function.invoke",
        requestId: "req-3",
        input: { functionId: "score_check", kind: "verification", grants: [] },
      },
      { async call() { called = true; return successView(); }, async cancel() {} },
      "/projects/app",
      (message) => sent.push(message),
      () => true,
      { grantsFor: () => undefined },
    );
    expect(called).toBe(false);
    expect(sent[0]).toMatchObject({ view: { ok: false, code: "permission_denied" } });
  });

  it("answers a child capability from the broker that started the call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fn-host-cap-"));
    const replies: unknown[] = [];
    setHostFunctionForkForTests((() => {
      const child = fakeChild();
      child.send = ((message: unknown) => {
        const record = message as { type?: string };
        if (record.type === "invoke") {
          queueMicrotask(() => {
            child.emit("message", {
              type: "capability",
              requestId: "cap-1",
              op: "readText",
              root: "workspace",
              path: "note.txt",
            });
          });
        } else {
          replies.push(message);
          queueMicrotask(() => child.emitSuccess());
        }
        return true;
      }) as ChildProcess["send"];
      return child;
    }) as typeof childProcess.fork);
    const broker = new FunctionBroker({
      executor: hostFunctionExecutor(),
      stageflowHome: path.join(root, "home"),
    });

    const result = await broker.invoke({
      invocationId: "cap-call",
      kind: "verification",
      source: SYNC_OK,
      context: {},
      timeoutMs: 5_000,
      roots: { workspace: root, artifacts: root },
      projectRoot: root,
      grants: { files: [] },
    });

    expect(replies[0]).toMatchObject({
      type: "capability_result",
      requestId: "cap-1",
      ok: false,
      code: "permission_denied",
    });
    expect(JSON.stringify(replies[0])).not.toContain("no owner");
    expect(result.ok).toBe(true);
  });

  it("sizes the worker host timeout for a full admission queue", () => {
    expect(HOST_TIMEOUT_MS).toBe(6 * (FUNCTION_TIMEOUT_MS_MAX + FUNCTION_KILL_GRACE_MS) + 1_000);
  });

  it("refuses a call when the wait queue is already full", async () => {
    let started = 0;
    const hanging: Array<() => void> = [];
    const executor = new FunctionExecutor({
      forkFn: (() => {
        started += 1;
        const child = fakeChild();
        child.send = (() => {
          hanging.push(() => child.emitSuccess());
          return true;
        }) as ChildProcess["send"];
        return child;
      }) as typeof childProcess.fork,
    });
    setHostFunctionExecutorForTests(executor);
    const broker = new FunctionBroker({ executor: hostFunctionExecutor() });
    const invoke = (invocationId: string) =>
      broker.invoke({
        invocationId,
        kind: "verification",
        source: SYNC_OK,
        context: {},
        timeoutMs: FUNCTION_TIMEOUT_MS_MAX,
      });

    const running = Promise.all(
      Array.from({ length: FUNCTION_MAX_RUNNING }, (_, index) => invoke(`run-${index}`)),
    );
    await vi.waitFor(() => expect(started).toBe(FUNCTION_MAX_RUNNING));
    Array.from({ length: FUNCTION_MAX_WAITING }, (_, index) => invoke(`wait-${index}`));
    await expect(invoke("overflow")).resolves.toMatchObject({
      ok: false,
      code: "resource_limit",
      message: "function execution queue is full",
    });
    for (const finish of hanging.splice(0)) finish();
    await running;
  });

  it("does not time out the last accepted waiter before the host responds", async () => {
    vi.useFakeTimers();
    let started = 0;
    const hanging: Array<() => void> = [];
    const executor = new FunctionExecutor({
      forkFn: (() => {
        started += 1;
        const child = fakeChild();
        child.send = (() => {
          hanging.push(() => child.emitSuccess());
          return true;
        }) as ChildProcess["send"];
        return child;
      }) as typeof childProcess.fork,
    });
    setHostFunctionExecutorForTests(executor);
    const shared = hostFunctionExecutor();
    const broker = new FunctionBroker({ executor: shared });
    const host: StageFunctionHost = {
      async call(_projectRoot, input) {
        const result = await broker.invoke({
          invocationId: input.invocationId ?? "missing",
          kind: input.kind,
          source: SYNC_OK,
          context: {},
          timeoutMs: FUNCTION_TIMEOUT_MS_MAX,
        });
        if (!result.ok) {
          throw new Error(result.message);
        }
        return successView();
      },
      async cancel() {},
    };
    const invokeOnBroker = (invocationId: string) =>
      broker.invoke({
        invocationId,
        kind: "verification",
        source: SYNC_OK,
        context: {},
        timeoutMs: FUNCTION_TIMEOUT_MS_MAX,
      });

    const transport = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send(message: unknown, callback?: (error: Error | null) => void): boolean;
    };
    transport.connected = true;
    transport.send = (message, callback) => {
      const request = message as { type?: string; requestId?: string; input?: FunctionCallInput };
      if (request.type === "function.invoke" && request.requestId && request.input) {
        queueMicrotask(() => {
          void handleStageFunctionMessage(
            { type: "function.invoke", requestId: request.requestId, input: request.input },
            host,
            "/projects/app",
            (response) => transport.emit("message", response),
            () => true,
            { grantsFor: () => [] },
          );
        });
      }
      callback?.(null);
      return true;
    };

    const oldHostTimeout = FUNCTION_TIMEOUT_MS_MAX + FUNCTION_KILL_GRACE_MS + 1_000;
    try {
      const running = Promise.all(
        Array.from({ length: FUNCTION_MAX_RUNNING }, (_, index) => invokeOnBroker(`run-${index}`)),
      );
      await vi.waitFor(() => expect(started).toBe(FUNCTION_MAX_RUNNING));
      Array.from({ length: FUNCTION_MAX_WAITING - 1 }, (_, index) => invokeOnBroker(`wait-${index}`));
      const settled: FunctionRunView[] = [];
      const lastWaiter = callFunctionOnHost({ functionId: "score_check", kind: "verification" }, transport).then((view) => {
        settled.push(view);
        return view;
      });
      await vi.waitFor(() => expect(started).toBe(FUNCTION_MAX_RUNNING));
      vi.advanceTimersByTime(oldHostTimeout + 1);
      await Promise.resolve();
      expect(settled).toHaveLength(0);
      while (hanging.length > 0) {
        for (const finish of hanging.splice(0)) finish();
        await Promise.resolve();
      }
      await running;
      const view = await lastWaiter;
      expect(view).toMatchObject({ ok: true, value: { passed: true } });
      expect(view.message).not.toBe("function host timed out");
    } finally {
      while (hanging.length > 0) hanging.shift()?.();
      vi.useRealTimers();
    }
  });

  it("asks the host instead of forking from a stage worker", async () => {
    const db = new Database(":memory:");
    const forked = vi.fn();
    const invoker = createFunctionInvoker({
      db,
      forkFn: forked as typeof childProcess.fork,
    });
    const previousWorker = process.env[SF_STAGE_WORKER];
    const previousSend = process.send;
    const previousConnected = Object.getOwnPropertyDescriptor(process, "connected");
    const sent: Array<{ type?: string }> = [];
    process.env[SF_STAGE_WORKER] = "1";
    process.send = ((message: unknown, callback?: (error: Error | null) => void) => {
      const request = message as { type?: string; requestId?: string };
      sent.push(request);
      if (request.type === "function.invoke") {
        queueMicrotask(() => {
          process.emit("message", {
            type: "function.response",
            requestId: request.requestId,
            view: successView(),
          });
        });
      }
      callback?.(null);
      return true;
    }) as typeof process.send;
    Object.defineProperty(process, "connected", { configurable: true, value: true });
    try {
      const view = await invoker.call("/tmp/project", { functionId: "score_check", kind: "verification" });
      expect(view).toMatchObject({ ok: true, value: { passed: true } });
      expect(forked).not.toHaveBeenCalled();
      expect(sent[0]?.type).toBe("function.invoke");
    } finally {
      db.close();
      if (previousWorker === undefined) delete process.env[SF_STAGE_WORKER];
      else process.env[SF_STAGE_WORKER] = previousWorker;
      process.send = previousSend;
      if (previousConnected) Object.defineProperty(process, "connected", previousConnected);
      else delete (process as { connected?: boolean }).connected;
    }
  });
});
