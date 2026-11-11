import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FunctionExecutor } from "../src/functions/executor.js";

const SYNC_OK = "export default function execute(){ return { ok: true }; }";
const ASYNC_OK =
  "export default async function execute(){ await Promise.resolve(); return { ok: true }; }";
const DIVE = "export default function execute(){ function dive(){ return dive(); } return dive(); }";

const grandchildFixture = fileURLToPath(
  new URL("./fixtures/verifyHangWithGrandchild.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let invocationSeq = 0;

function invocationId(prefix: string): string {
  invocationSeq += 1;
  return `${prefix}-${invocationSeq}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function successMessage(): {
  type: "result";
  ok: true;
  value: { ok: true };
  logs: string;
  logsTruncated: false;
  disposed: true;
} {
  return {
    type: "result",
    ok: true,
    value: { ok: true },
    logs: "",
    logsTruncated: false,
    disposed: true,
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
    child.emit("message", successMessage());
    child.emit("exit", 0, null);
  };
  return child;
}

describe("function executor", () => {
  it("runs sync and async execute through the same validator", async () => {
    const executor = new FunctionExecutor();
    const sync = await executor.invoke({
      invocationId: invocationId("sync"),
      source: SYNC_OK,
      context: {},
    });
    const asyncResult = await executor.invoke({
      invocationId: invocationId("async"),
      source: ASYNC_OK,
      context: {},
    });

    expect(sync).toMatchObject({
      ok: true,
      value: { ok: true },
      disposed: true,
      logsTruncated: false,
    });
    expect(asyncResult.ok).toBe(true);
    expect(asyncResult.value).toEqual(sync.value);
    expect(asyncResult.disposed).toBe(true);
    expect(String(sync.wasmFile)).toContain("quickjs-wasmfile-release-sync");
    expect(String(asyncResult.wasmFile)).toContain("quickjs-wasmfile-release-sync");
  });

  it("passes a json context and a guest cancellation flag", async () => {
    const executor = new FunctionExecutor();
    const result = await executor.invoke({
      invocationId: invocationId("context"),
      source: `
        export default function execute(context) {
          return {
            n: context.n,
            aborted: context.signal.aborted,
            signalKeys: Object.keys(context.signal).sort(),
          };
        }
      `,
      context: { n: 2 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { n: 2, aborted: false, signalKeys: ["aborted"] },
      disposed: true,
    });
  });

  it("rejects inputs that are not strict json before starting a child", async () => {
    let started = 0;
    const executor = new FunctionExecutor({
      forkFn: (() => {
        started += 1;
        const child = fakeChild();
        child.send = (() => {
          queueMicrotask(() => child.emitSuccess());
          return true;
        }) as ChildProcess["send"];
        return child;
      }) as typeof childProcess.fork,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Box {
      n = 1;
    }
    const cases: unknown[] = [
      { missing: undefined },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { n: 1n },
      { f() {} },
      cyclic,
      new Box(),
      null,
      [1],
    ];

    for (const context of cases) {
      const result = await executor.invoke({
        invocationId: invocationId("bad-input"),
        source: SYNC_OK,
        context,
      });
      expect(result).toMatchObject({ ok: false, code: "invalid_input" });
      expect(result.pid).toBeUndefined();
    }
    expect(started).toBe(0);
  });

  it("rejects outputs that are not strict json", async () => {
    const executor = new FunctionExecutor();
    const sources = [
      "export default function execute(){ return undefined; }",
      "export default function execute(){ return NaN; }",
      "export default function execute(){ return Infinity; }",
      "export default function execute(){ return 1n; }",
      "export default function execute(){ return function hidden(){}; }",
      "export default function execute(){ const value = {}; value.self = value; return value; }",
      "export default function execute(){ class Box { constructor(){ this.n = 1; } } return new Box(); }",
    ];

    for (const source of sources) {
      const result = await executor.invoke({
        invocationId: invocationId("bad-output"),
        source,
        context: {},
      });
      expect(result).toMatchObject({
        ok: false,
        code: "invalid_output",
        disposed: true,
      });
      expect(result.value).toBeUndefined();
    }

    const accepted = await executor.invoke({
      invocationId: invocationId("json-output"),
      source:
        "export default function execute(){ return { items: [1, true, null, 'a'], nested: { z: 0 } }; }",
      context: {},
    });
    expect(accepted).toMatchObject({
      ok: true,
      value: { items: [1, true, null, "a"], nested: { z: 0 } },
    });
  });

  it("stops a tight loop by interrupt or parent kill and accepts another call", async () => {
    const executor = new FunctionExecutor();
    const started = Date.now();
    const timeoutMs = 2000;
    const hung = executor.invoke({
      invocationId: invocationId("loop"),
      source: "export default function execute(){ while (true) {} }",
      context: {},
      timeoutMs,
    });
    const next = await executor.invoke({
      invocationId: invocationId("after-loop"),
      source: SYNC_OK,
      context: {},
    });
    const first = await hung;

    expect(next).toMatchObject({ ok: true, value: { ok: true } });
    expect(["timeout", "killed"]).toContain(first.code);
    expect(first.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(timeoutMs + 250 + 5000);
    expect(next.pid).not.toBe(first.pid);
  });

  it("stops a self-rescheduling promise at the job cap", async () => {
    const executor = new FunctionExecutor();
    const timeoutMs = 8000;
    const started = Date.now();
    const result = await executor.invoke({
      invocationId: invocationId("jobs"),
      source: `
        export default function execute() {
          function loop() { return Promise.resolve().then(loop); }
          return loop();
        }
      `,
      context: {},
      timeoutMs,
    });
    const next = await executor.invoke({
      invocationId: invocationId("after-jobs"),
      source: SYNC_OK,
      context: {},
    });

    expect(result).toMatchObject({
      ok: false,
      code: "job_limit",
      disposed: true,
    });
    expect(Date.now() - started).toBeLessThan(timeoutMs);
    expect(next).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("records a parent kill when a forced interrupt stays inside evaluation", async () => {
    const executor = new FunctionExecutor();
    const result = await executor.invoke({
      invocationId: invocationId("array"),
      source: "export default function execute(){ return new Array(10000000) + ''; }",
      context: {},
      timeoutMs: 400,
      forceInterrupt: true,
    });
    const endedByParentKill = result.code === "killed";
    expect(result.ok).toBe(false);
    if (endedByParentKill) {
      expect(result.code).toBe("killed");
      expect(result.pid).toEqual(expect.any(Number));
    } else {
      expect(["timeout", "memory", "output_limit", "exception"]).toContain(result.code);
    }

    const next = await executor.invoke({
      invocationId: invocationId("after-array"),
      source: SYNC_OK,
      context: {},
    });
    expect(next).toMatchObject({ ok: true, value: { ok: true } });
    expect(next.pid).not.toBe(result.pid);
  });

  it("returns a guest stack error at the default stack limit", async () => {
    const executor = new FunctionExecutor();
    const result = await executor.invoke({
      invocationId: invocationId("stack"),
      source: DIVE,
      context: {},
    });

    expect(result).toMatchObject({
      ok: false,
      code: "stack",
      disposed: true,
    });
    expect(result.message).toMatch(/stack/i);
  });

  it("kills a process when the stack limit is removed and then starts a new one", async () => {
    const executor = new FunctionExecutor();
    const first = await executor.invoke({
      invocationId: invocationId("no-stack"),
      source: DIVE,
      context: {},
      stackSizeBytes: null,
      timeoutMs: 1000,
    });
    const second = await executor.invoke({
      invocationId: invocationId("after-no-stack"),
      source: SYNC_OK,
      context: {},
    });

    expect(first.ok).toBe(false);
    expect(first.code).toBe("killed");
    expect(first.pid).toEqual(expect.any(Number));
    expect(second).toMatchObject({ ok: true, value: { ok: true } });
    expect(second.pid).not.toBe(first.pid);
  });

  it("fails an allocation past the memory limit and disposes", async () => {
    const executor = new FunctionExecutor();
    const result = await executor.invoke({
      invocationId: invocationId("memory"),
      source: "export default function execute(){ 'x'.repeat(8 * 1024 * 1024); }",
      context: {},
      memoryLimitBytes: 4 * 1024 * 1024,
      timeoutMs: 8000,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "memory",
      disposed: true,
    });
  });

  it("refuses an output string quickjs can produce when it exceeds 256 KiB", async () => {
    const executor = new FunctionExecutor();
    const result = await executor.invoke({
      invocationId: invocationId("output"),
      source: "export default function execute(){ return 'x'.repeat(1024 * 1024); }",
      context: {},
      memoryLimitBytes: 16 * 1024 * 1024,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "output_limit",
      disposed: true,
    });
    expect(result.value).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(32 * 1024);
  });

  it("rejects source, input, timeout, and memory above their ceilings before a child starts", async () => {
    let started = 0;
    const executor = new FunctionExecutor({
      forkFn: (() => {
        started += 1;
        throw new Error("child started");
      }) as typeof childProcess.fork,
    });

    const source = await executor.invoke({
      invocationId: invocationId("source-limit"),
      source: `${SYNC_OK}\n${" ".repeat(64 * 1024)}`,
      context: {},
    });
    const input = await executor.invoke({
      invocationId: invocationId("input-limit"),
      source: SYNC_OK,
      context: { blob: "x".repeat(256 * 1024) },
    });
    const timeout = await executor.invoke({
      invocationId: invocationId("timeout-ceiling"),
      source: SYNC_OK,
      context: {},
      timeoutMs: 30001,
    });
    const memory = await executor.invoke({
      invocationId: invocationId("memory-ceiling"),
      source: SYNC_OK,
      context: {},
      memoryLimitBytes: 64 * 1024 * 1024 + 1,
    });

    expect(source).toMatchObject({ ok: false, code: "source_limit" });
    expect(input).toMatchObject({ ok: false, code: "input_limit" });
    expect(timeout).toMatchObject({ ok: false, code: "timeout" });
    expect(memory).toMatchObject({ ok: false, code: "memory" });
    expect(started).toBe(0);
  });

  it("fails disposal when a debug handle is leaked", async () => {
    const executor = new FunctionExecutor();
    const result = await executor.invoke({
      invocationId: invocationId("leak"),
      source: SYNC_OK,
      context: {},
      wasm: "debug",
      leakHandle: true,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "disposal",
      disposed: false,
    });
    expect(String(result.wasmFile)).toContain("quickjs-wasmfile-debug-sync");
  });

  it("disposes the debug runtime after success, interrupt, and rejected output", async () => {
    const executor = new FunctionExecutor();
    const success = await executor.invoke({
      invocationId: invocationId("debug-ok"),
      source: SYNC_OK,
      context: {},
      wasm: "debug",
    });
    const interrupted = await executor.invoke({
      invocationId: invocationId("debug-loop"),
      source: "export default function execute(){ while (true) {} }",
      context: {},
      timeoutMs: 5000,
      wasm: "debug",
    });
    const denied = await executor.invoke({
      invocationId: invocationId("debug-deny"),
      source: "export default function execute(){ return function hidden(){}; }",
      context: {},
      wasm: "debug",
    });

    expect(success).toMatchObject({
      ok: true,
      value: { ok: true },
      disposed: true,
    });
    expect(interrupted).toMatchObject({
      ok: false,
      code: "timeout",
      disposed: true,
    });
    expect(denied).toMatchObject({
      ok: false,
      code: "invalid_output",
      disposed: true,
    });
    expect(String(success.wasmFile)).toContain("quickjs-wasmfile-debug-sync");
  });

  it("omits process, require, fetch, and fs, and a guest import throws", async () => {
    const executor = new FunctionExecutor();
    const absent = await executor.invoke({
      invocationId: invocationId("absent"),
      source: `
        export default function execute() {
          return {
            process: typeof process,
            require: typeof require,
            fetch: typeof fetch,
            fs: typeof fs,
          };
        }
      `,
      context: {},
      wasm: "debug",
    });
    const imported = await executor.invoke({
      invocationId: invocationId("import"),
      source: "import missing from './missing.js'; export default function execute(){ return missing; }",
      context: {},
      wasm: "debug",
    });

    expect(absent).toMatchObject({
      ok: true,
      disposed: true,
      value: {
        process: "undefined",
        require: "undefined",
        fetch: "undefined",
        fs: "undefined",
      },
    });
    expect(imported.ok).toBe(false);
    expect(imported.disposed).toBe(true);
    expect(imported.message ?? "").toMatch(/import|module/i);
  });

  it("cuts logs off at 16 KiB and accepts another call", async () => {
    const executor = new FunctionExecutor();
    const result = await executor.invoke({
      invocationId: invocationId("logs"),
      source: `
        export default function execute(context) {
          const chunk = "x".repeat(1024);
          for (let i = 0; i < 20; i++) context.log(chunk);
          return { ok: true };
        }
      `,
      context: {},
    });
    const next = await executor.invoke({
      invocationId: invocationId("after-logs"),
      source: SYNC_OK,
      context: {},
    });

    expect(result).toMatchObject({ ok: true, value: { ok: true }, logsTruncated: true });
    expect(Buffer.byteLength(result.logs, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(result.logs, "utf8")).toBeGreaterThan(8 * 1024);
    expect(next).toMatchObject({
      ok: true,
      value: { ok: true },
      logs: "",
      logsTruncated: false,
    });
  });

  it("spawns a child without the parent environment", async () => {
    const previous = process.env.STAGEFLOW_EXECUTOR_SENTINEL;
    process.env.STAGEFLOW_EXECUTOR_SENTINEL = "parent-secret";
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      const executor = new FunctionExecutor({
        forkFn: ((_modulePath, _args, options) => {
          seen.push(options?.env);
          const child = fakeChild();
          child.send = (() => {
            queueMicrotask(() => child.emitSuccess());
            return true;
          }) as ChildProcess["send"];
          return child;
        }) as typeof childProcess.fork,
      });
      const result = await executor.invoke({
        invocationId: invocationId("env"),
        source: SYNC_OK,
        context: {},
      });
      expect(result).toMatchObject({ ok: true, value: { ok: true } });
    } finally {
      if (previous === undefined) delete process.env.STAGEFLOW_EXECUTOR_SENTINEL;
      else process.env.STAGEFLOW_EXECUTOR_SENTINEL = previous;
    }

    expect(seen).toHaveLength(1);
    const env = seen[0] ?? {};
    expect(env.STAGEFLOW_EXECUTOR_SENTINEL).toBeUndefined();
    expect(env.STAGEFLOW_HOME).toBeUndefined();
    expect(env.STAGEFLOW_CREDENTIAL_HOME).toBeUndefined();
    expect(env).not.toBe(process.env);
  });

  it("returns a resource limit when the queue is full and cancel while queued never starts a child", async () => {
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

    const running = ["r1", "r2", "r3", "r4"].map((name) =>
      executor.invoke({
        invocationId: name,
        source: SYNC_OK,
        context: {},
        timeoutMs: 20000,
      }),
    );
    await vi.waitFor(() => expect(started).toBe(4));

    const waitingIds = Array.from({ length: 16 }, (_, index) => `wait-${index}`);
    const waiting = waitingIds.map((name) =>
      executor.invoke({
        invocationId: name,
        source: SYNC_OK,
        context: {},
        timeoutMs: 20000,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toBe(4);

    const overflow = await executor.invoke({
      invocationId: "overflow",
      source: SYNC_OK,
      context: {},
      timeoutMs: 20000,
    });
    expect(overflow).toMatchObject({ ok: false, code: "resource_limit" });
    expect(overflow.pid).toBeUndefined();
    expect(started).toBe(4);

    const cancelPromise = executor.cancel("wait-15");
    await expect(waiting[15]).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
    });
    expect((await waiting[15]).pid).toBeUndefined();
    await cancelPromise;
    expect(started).toBe(4);

    release = true;
    for (const finish of hanging) finish();
    const outcomes = await Promise.all(running.concat(waiting.slice(0, 15)));
    expect(outcomes.every((result) => result.ok)).toBe(true);

    const later = await executor.invoke({
      invocationId: invocationId("after-queue"),
      source: SYNC_OK,
      context: {},
    });
    expect(later).toMatchObject({ ok: true, value: { ok: true } });
    expect(started).toBe(4 + 15 + 1);
  });

  it("kills the running process group on cancel and a later call still runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fn-kill-"));
    const pidFile = path.join(root, "grandchild.pid");
    let hang = true;
    const executor = new FunctionExecutor({
      forkFn: ((modulePath, args, options) => {
        if (hang) {
          return childProcess.fork(grandchildFixture, [], {
            ...options,
            env: {
              ...(options?.env ?? {}),
              VERIFY_GRANDCHILD_PID_FILE: pidFile,
            },
          });
        }
        return childProcess.fork(modulePath, args ?? [], options);
      }) as typeof childProcess.fork,
    });

    const pending = executor.invoke({
      invocationId: "hang",
      source: "export default function execute(){ while (true) {} }",
      context: {},
      timeoutMs: 20000,
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

    await executor.cancel("hang");
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(result.pid).toEqual(expect.any(Number));
    expect(result.pid).not.toBe(grandchildPid);
    await vi.waitFor(() => expect(pidAlive(grandchildPid)).toBe(false), {
      timeout: 2000,
    });

    hang = false;
    const next = await executor.invoke({
      invocationId: invocationId("after-cancel"),
      source: SYNC_OK,
      context: {},
    });
    expect(next).toMatchObject({ ok: true, value: { ok: true } });
    expect(next.pid).not.toBe(result.pid);
  });

  it("evaluates 1 + 1 from the built entry with the release sync wasm", () => {
    execFileSync("npm", ["run", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { FunctionExecutor } from "./dist/functions/executor.js";
          const executor = new FunctionExecutor();
          const result = await executor.invoke({
            invocationId: "built-smoke",
            source: "export default function execute(){ return 1 + 1; }",
            context: {},
          });
          if (!result.ok || result.value !== 2) {
            console.error(JSON.stringify(result));
            process.exit(1);
          }
          if (!String(result.wasmFile).includes("quickjs-wasmfile-release-sync")) {
            console.error(result.wasmFile);
            process.exit(2);
          }
        `,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }, 180_000);
});
