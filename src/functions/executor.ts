import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FUNCTION_JSON_BYTES_MAX,
  FUNCTION_KILL_GRACE_MS,
  FUNCTION_LOG_BYTES_MAX,
  FUNCTION_MAX_RUNNING,
  FUNCTION_MAX_WAITING,
  FUNCTION_MEMORY_BYTES_DEFAULT,
  FUNCTION_MEMORY_BYTES_MAX,
  FUNCTION_SOURCE_BYTES_MAX,
  FUNCTION_STACK_BYTES,
  FUNCTION_TIMEOUT_MS_DEFAULT,
  FUNCTION_TIMEOUT_MS_MAX,
  assertJsonObject,
  assertJsonValue,
  isCapabilityRequest,
  isChildResponse,
  jsonByteLength,
  truncateUtf8,
  type FunctionCapabilityRequest,
  type FunctionCapabilityResult,
  type FunctionChildRequest,
  type FunctionChildResponse,
  type FunctionInvokeRequest,
  type FunctionInvokeResult,
} from "./protocol.js";

export type { FunctionInvokeRequest, FunctionInvokeResult } from "./protocol.js";

type PreparedInvoke = {
  invocationId: string;
  timeoutMs: number;
  request: FunctionChildRequest;
};

type Waiter = {
  id: string;
  start: () => void;
  cancel: () => void;
};

type RunningCall = {
  id: string;
  child: ChildProcess;
  cancelled: boolean;
  hostKilled: boolean;
  externalWrite: boolean;
  abort: AbortController;
  exited: Promise<void>;
};

export type FunctionCapabilityHandler = (
  invocationId: string,
  request: FunctionCapabilityRequest,
  signal: AbortSignal,
) => Promise<FunctionCapabilityResult>;

export type FunctionExecutorOptions = {
  forkFn?: typeof childProcess.fork;
  onCapability?: FunctionCapabilityHandler;
  sideEffect?: (invocationId: string, request: FunctionCapabilityRequest) => boolean;
};

export class FunctionExecutor {
  private readonly forkFn: typeof childProcess.fork;
  private readonly onCapability: FunctionCapabilityHandler | undefined;
  private readonly sideEffect: FunctionExecutorOptions["sideEffect"];
  private active = 0;
  private readonly running = new Map<string, RunningCall>();
  private readonly waiting: Waiter[] = [];

  constructor(options: FunctionExecutorOptions = {}) {
    this.forkFn = options.forkFn ?? childProcess.fork;
    this.onCapability = options.onCapability;
    this.sideEffect = options.sideEffect;
  }

  invoke(input: FunctionInvokeRequest): Promise<FunctionInvokeResult> {
    const prepared = prepareInvoke(input);
    if (!prepared.ok) return Promise.resolve(prepared.result);
    if (this.running.has(input.invocationId) || this.waiting.some((entry) => entry.id === input.invocationId)) {
      return Promise.resolve(result("duplicate", "function invocation is already active"));
    }
    if (this.active >= FUNCTION_MAX_RUNNING) {
      if (this.waiting.length >= FUNCTION_MAX_WAITING) {
        return Promise.resolve(result("resource_limit", "function execution queue is full"));
      }
      return new Promise((resolve) => {
        this.waiting.push({
          id: input.invocationId,
          start: () => {
            resolve(this.start(prepared.value));
          },
          cancel: () => {
            resolve(result("cancelled", "function execution cancelled"));
          },
        });
      });
    }
    this.active += 1;
    return this.start(prepared.value);
  }

  cancel(invocationId: string): Promise<void> {
    const index = this.waiting.findIndex((entry) => entry.id === invocationId);
    if (index >= 0) {
      const [entry] = this.waiting.splice(index, 1);
      entry?.cancel();
      return Promise.resolve();
    }
    const running = this.running.get(invocationId);
    if (!running) return Promise.resolve();
    running.cancelled = true;
    running.abort.abort();
    signalProcessGroup(running.child.pid, "SIGKILL");
    return running.exited;
  }

  private start(prepared: PreparedInvoke): Promise<FunctionInvokeResult> {
    const request: FunctionChildRequest = {
      ...prepared.request,
      deadlineAt: Date.now() + prepared.timeoutMs,
    };
    const program = childProgram();
    let child: ChildProcess;
    try {
      child = this.forkFn(program.entry, [], {
        cwd: process.cwd(),
        env: {},
        execArgv: program.execArgv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      });
    } catch (error) {
      this.release();
      return Promise.resolve(result("exception", error instanceof Error ? error.message : String(error)));
    }
    return this.track({ ...prepared, request }, child, prepared.timeoutMs);
  }

  private track(
    prepared: PreparedInvoke,
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<FunctionInvokeResult> {
    let resolveExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const running: RunningCall = {
      id: prepared.invocationId,
      child,
      cancelled: false,
      hostKilled: false,
      externalWrite: false,
      abort: new AbortController(),
      exited,
    };
    this.running.set(prepared.invocationId, running);
    const pid = typeof child.pid === "number" ? child.pid : undefined;
    let stderr = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= 4_096) return;
      stderr += chunk.toString();
    });

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        running.hostKilled = true;
        running.abort.abort();
        signalProcessGroup(child.pid, "SIGKILL");
      }, timeoutMs + FUNCTION_KILL_GRACE_MS);

      const finish = (value: FunctionInvokeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(prepared.invocationId);
        resolveExited();
        resolve(value);
        this.release();
      };

      child.once("error", (error) => {
        finish(result("exception", error.message, pid));
      });
      child.on("message", (message: unknown) => {
        if (isCapabilityRequest(message)) {
          this.answerCapability(prepared.invocationId, running, child, message);
          return;
        }
        if (!isChildResponse(message) || running.cancelled || running.hostKilled) return;
        if (running.externalWrite && !message.ok) {
          running.abort.abort();
          finish(result("uncertain_outcome", "function external outcome is uncertain", pid));
          return;
        }
        finish(fromChild(message, pid));
      });
      child.once("exit", (code, signal) => {
        if (running.cancelled || running.hostKilled) {
          signalProcessGroup(child.pid, "SIGKILL");
        }
        if (settled) return;
        if (running.externalWrite) {
          finish(result("uncertain_outcome", "function external outcome is uncertain", pid));
          return;
        }
        if (running.cancelled) {
          finish(result("cancelled", "function execution cancelled", pid));
          return;
        }
        if (running.hostKilled || signal) {
          finish(result("killed", exitReason(code, signal), pid));
          return;
        }
        const detail = stderr.trim().slice(0, 500);
        finish(
          result(
            "exception",
            detail || (code === null ? "function process exited" : `function process exit ${code}`),
            pid,
          ),
        );
      });

      try {
        child.send?.(prepared.request);
      } catch (error) {
        finish(result("exception", error instanceof Error ? error.message : String(error), pid));
      }
    });
  }

  private answerCapability(
    invocationId: string,
    running: RunningCall,
    child: ChildProcess,
    request: FunctionCapabilityRequest,
  ): void {
    if (running.cancelled || running.hostKilled || running.abort.signal.aborted) return;
    const effect = request.op === "write" || this.sideEffect?.(invocationId, request) === true;
    if (effect) running.externalWrite = true;
    const pending = this.onCapability
      ? this.onCapability(invocationId, request, running.abort.signal)
      : Promise.resolve(deniedCapability(request.requestId));
    void pending.then(
      (value) => {
        if (effect) running.externalWrite = false;
        this.sendCapability(running, child, value);
      },
      () => {
        if (effect) running.externalWrite = false;
        this.sendCapability(running, child, deniedCapability(request.requestId));
      },
    );
  }

  private sendCapability(running: RunningCall, child: ChildProcess, value: FunctionCapabilityResult): void {
    if (running.cancelled || running.hostKilled || running.abort.signal.aborted) return;
    try {
      child.send?.(value);
    } catch {
      return;
    }
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (!next) return;
    this.active += 1;
    next.start();
  }
}

function prepareInvoke(
  input: FunctionInvokeRequest,
): { ok: true; value: PreparedInvoke } | { ok: false; result: FunctionInvokeResult } {
  if (typeof input.source !== "string") {
    return { ok: false, result: result("source_limit", "function source must be a string") };
  }
  if (Buffer.byteLength(input.source, "utf8") > FUNCTION_SOURCE_BYTES_MAX) {
    return { ok: false, result: result("source_limit", "function source exceeds 64 KiB") };
  }
  const context = assertJsonObject(input.context);
  if (!context.ok) return { ok: false, result: result("invalid_input", context.message) };
  if (jsonByteLength(context.value) > FUNCTION_JSON_BYTES_MAX) {
    return { ok: false, result: result("input_limit", "function input exceeds 256 KiB") };
  }
  const timeout = resolveTimeout(input.timeoutMs);
  if (!timeout.ok) return { ok: false, result: result("timeout", timeout.message) };
  const memory = resolveMemory(input.memoryLimitBytes);
  if (!memory.ok) return { ok: false, result: result("memory", memory.message) };
  const stack = resolveStack(input.stackSizeBytes);
  if (!stack.ok) return { ok: false, result: result("stack", stack.message) };
  return {
    ok: true,
    value: {
      invocationId: input.invocationId,
      timeoutMs: timeout.value,
      request: {
        type: "invoke",
        source: input.source,
        context: context.value,
        deadlineAt: 0,
        memoryLimitBytes: memory.value,
        stackSizeBytes: stack.value,
        forceInterrupt: input.forceInterrupt === true,
        leakHandle: input.leakHandle === true,
        wasm: input.wasm === "debug" ? "debug" : "release",
      },
    },
  };
}

function resolveTimeout(value: number | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: FUNCTION_TIMEOUT_MS_DEFAULT };
  if (!Number.isInteger(value) || value < 1 || value > FUNCTION_TIMEOUT_MS_MAX) {
    return { ok: false, message: `function timeout must be from 1 to ${FUNCTION_TIMEOUT_MS_MAX} ms` };
  }
  return { ok: true, value };
}

function resolveMemory(value: number | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: FUNCTION_MEMORY_BYTES_DEFAULT };
  if (!Number.isInteger(value) || value < 1 || value > FUNCTION_MEMORY_BYTES_MAX) {
    return {
      ok: false,
      message: `function memory limit must be from 1 byte to ${FUNCTION_MEMORY_BYTES_MAX} bytes`,
    };
  }
  return { ok: true, value };
}

function resolveStack(
  value: number | null | undefined,
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: FUNCTION_STACK_BYTES };
  if (value === null) return { ok: true, value: null };
  if (!Number.isInteger(value) || value < 0 || value > FUNCTION_STACK_BYTES) {
    return { ok: false, message: "function stack limit must be 256 KiB or removed" };
  }
  return { ok: true, value };
}

function fromChild(message: FunctionChildResponse, pid: number | undefined): FunctionInvokeResult {
  const logs = truncateUtf8(message.logs, FUNCTION_LOG_BYTES_MAX);
  const base: FunctionInvokeResult = {
    ok: false,
    logs: logs.text,
    logsTruncated: message.logsTruncated === true || logs.truncated,
    ...(typeof message.code === "string" ? { code: message.code } : {}),
    ...(typeof message.message === "string" ? { message: message.message } : {}),
    ...(pid !== undefined ? { pid } : {}),
    disposed: message.disposed === true,
    ...(typeof message.wasmFile === "string" ? { wasmFile: message.wasmFile } : {}),
  };
  if (!message.ok) return base;
  const value = assertJsonValue(message.value);
  if (!value.ok || jsonByteLength(value.value) > FUNCTION_JSON_BYTES_MAX) {
    return {
      ...base,
      code: value.ok ? "output_limit" : "invalid_output",
      message: value.ok ? "function output exceeds 256 KiB" : value.message,
    };
  }
  return { ...base, ok: true, value: value.value };
}

function deniedCapability(requestId: string): FunctionCapabilityResult {
  return {
    type: "capability_result",
    requestId,
    ok: false,
    code: "permission_denied",
    message: "capability denied",
  };
}

function result(code: string, message: string, pid?: number): FunctionInvokeResult {
  return {
    ok: false,
    code,
    message,
    logs: "",
    logsTruncated: false,
    ...(pid !== undefined ? { pid } : {}),
  };
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `function process exited (${signal})`;
  if (code === null) return "function process exited";
  return `function process exit ${code}`;
}

function childProgram(): { entry: string; execArgv: string[] } {
  const source = import.meta.url.split("?")[0]?.endsWith(".ts") === true;
  return {
    entry: fileURLToPath(new URL(source ? "./child.ts" : "./child.js", import.meta.url)),
    execArgv: source ? tsxExecArgv() : [],
  };
}

function tsxExecArgv(): string[] {
  try {
    const preflight = fileURLToPath(import.meta.resolve("tsx/preflight"));
    const loader = import.meta.resolve("tsx");
    return ["--require", preflight, "--import", loader];
  } catch {
    return [];
  }
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}
