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
  callFunctionOnHost,
  handleStageFunctionMessage,
  type StageFunctionHost,
} from "../src/functions/workerIpc.js";
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
    await expect(pending).rejects.toThrow("function host disconnected");
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

    await handleStageFunctionMessage(
      {
        type: "function.invoke",
        requestId: "req-1",
        input: { functionId: "score_check", kind: "verification", projectRoot: "/tmp/other" },
      },
      host,
      "/projects/app",
      (message) => sent.push(message),
      () => true,
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
    );
    expect(called).toBe(false);
      expect(sent[0]).toMatchObject({ view: { ok: false, code: "invalid_input" } });
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
