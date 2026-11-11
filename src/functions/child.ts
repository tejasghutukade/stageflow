import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Scope,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import {
  FUNCTION_JSON_BYTES_MAX,
  FUNCTION_LOG_BYTES_MAX,
  FUNCTION_MAX_PROMISE_JOBS,
  isCapabilityResult,
  type FunctionCapabilityRequest,
  type FunctionCapabilityResult,
  type FunctionChildRequest,
  type FunctionChildResponse,
  type FunctionWasmVariant,
  type JsonValue,
} from "./protocol.js";

const ENCODER = `
function __stageflowEncode(value) {
  const seen = new WeakSet();
  function walk(v) {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "undefined") throw new TypeError("strict-json:undefined");
    if (t === "number") {
      if (!Number.isFinite(v)) throw new TypeError("strict-json:non-finite");
      return JSON.stringify(v);
    }
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return JSON.stringify(v);
    if (t === "bigint") throw new TypeError("strict-json:bigint");
    if (t === "function") throw new TypeError("strict-json:function");
    if (t === "symbol") throw new TypeError("strict-json:symbol");
    if (t !== "object") throw new TypeError("strict-json:" + t);
    if (seen.has(v)) throw new TypeError("strict-json:cyclic");
    const proto = Object.getPrototypeOf(v);
    if (Array.isArray(v)) {
      if (proto !== Array.prototype) throw new TypeError("strict-json:instance");
      seen.add(v);
      let out = "[";
      for (let i = 0; i < v.length; i += 1) {
        if (i > 0) out += ",";
        out += walk(v[i]);
      }
      return out + "]";
    }
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("strict-json:instance");
    }
    seen.add(v);
    const keys = Object.keys(v);
    let out = "{";
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) out += ",";
      const key = keys[i];
      out += JSON.stringify(key) + ":" + walk(v[key]);
    }
    return out + "}";
  }
  return walk(value);
}
`;

const EXPLICIT_CODES = new Set([
  "permission_denied",
  "missing_binding",
  "uncertain_outcome",
  "cancelled",
  "file_limit",
  "not_found",
  "invalid_output",
]);

type CapabilityCall = {
  op: FunctionCapabilityRequest["op"];
  root?: string;
  path?: string;
  content?: string;
  method?: string;
  origin?: string;
  body?: string;
};

type HostBridge = {
  waiters: Promise<void>[];
  closed: boolean;
  call(input: CapabilityCall): Promise<FunctionCapabilityResult>;
  receive(message: FunctionCapabilityResult): void;
};

type LoadedQuickJs = {
  module: QuickJSWASMModule;
  wasmFile: string;
  wasm: FunctionWasmVariant;
};

export async function runFunctionChild(
  message: unknown,
  bridge: HostBridge = denyBridge(),
): Promise<FunctionChildResponse> {
  const request = readRequest(message);
  if (!request) {
    return {
      type: "result",
      ok: false,
      code: "exception",
      message: "function child received an invalid request",
      logs: "",
      logsTruncated: false,
      disposed: false,
    };
  }
  const loaded = await loadQuickJs(request.wasm);
  const logs = createLogBuffer();
  let hostStackOverflow = false;
  let response = baseResponse(loaded, logs);
  let runtime: QuickJSRuntime | undefined;
  let context: QuickJSContext | undefined;
  const scope = new Scope();
  try {
    runtime = loaded.module.newRuntime();
    runtime.setMemoryLimit(request.memoryLimitBytes);
    runtime.setMaxStackSize(request.stackSizeBytes ?? 0);
    let interruptArmed = false;
    runtime.setInterruptHandler(() => {
      if (interruptArmed && request.forceInterrupt) return true;
      return Date.now() >= request.deadlineAt;
    });
    context = runtime.newContext();
    const prepared = installEncoder(context, scope, logs);
    if (prepared) {
      response = withLogs(prepared, loaded, logs);
    } else {
      const encode = scope.manage(context.getProp(context.global, "__stageflowEncode"));
      const evaluated = scope.manage(
        context.evalCode(request.source, "function.js", { type: "module" }),
      );
      if (evaluated.error) {
        response = withLogs(failureFromHandle(context, evaluated.error), loaded, logs);
      } else {
        const execute = scope.manage(context.getProp(evaluated.value, "default"));
        if (context.typeof(execute) !== "function") {
          response = withLogs(
            {
              type: "result",
              ok: false,
              code: "invalid_export",
              message: "function must export default function execute",
              logs: logs.text(),
              logsTruncated: logs.truncated,
              disposed: false,
            },
            loaded,
            logs,
          );
        } else {
          const guestContext = buildContext(context, scope, request, logs, bridge);
          interruptArmed = true;
          const called = scope.manage(
            context.callFunction(execute, context.undefined, guestContext),
          );
          response = called.error
            ? withLogs(failureFromHandle(context, called.error), loaded, logs)
            : await settleCall(runtime, context, scope, called.value, encode, request, loaded, logs, bridge);
        }
      }
    }
  } catch (error) {
    if (isHostStackOverflow(error)) {
      hostStackOverflow = true;
    } else {
      response = withLogs(
        {
          type: "result",
          ok: false,
          code: "exception",
          message: errorText(error),
          logs: logs.text(),
          logsTruncated: logs.truncated,
          disposed: false,
        },
        loaded,
        logs,
      );
    }
  } finally {
    bridge.closed = true;
    if (hostStackOverflow) {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    } else if (runtime && context) {
      if (request.leakHandle) context.newNumber(1);
      scope.dispose();
      context.dispose();
      runtime.dispose();
      if (request.wasm === "debug" && recoverableLeak(loaded.module)) {
        response = withLogs(
          {
            type: "result",
            ok: false,
            code: "disposal",
            message: "a QuickJS handle was still allocated after disposal",
            logs: logs.text(),
            logsTruncated: logs.truncated,
            disposed: false,
          },
          loaded,
          logs,
        );
      } else {
        response = { ...response, disposed: true, logs: logs.text(), logsTruncated: logs.truncated };
      }
    }
  }
  return response;
}

function installEncoder(
  context: QuickJSContext,
  scope: Scope,
  logs: LogBuffer,
): FunctionChildResponse | undefined {
  const prelude = scope.manage(context.evalCode(ENCODER, "stageflow-encode.js"));
  if (!prelude.error) return undefined;
  return {
    type: "result",
    ok: false,
    code: "exception",
    message: readError(context, prelude.error).message,
    logs: logs.text(),
    logsTruncated: logs.truncated,
    disposed: false,
  };
}

function buildContext(
  context: QuickJSContext,
  scope: Scope,
  request: FunctionChildRequest,
  logs: LogBuffer,
  bridge: HostBridge,
): QuickJSHandle {
  const jsonText = scope.manage(context.newString(JSON.stringify(request.context)));
  const json = scope.manage(context.getProp(context.global, "JSON"));
  const parse = scope.manage(context.getProp(json, "parse"));
  const parsed = scope.manage(context.callFunction(parse, json, jsonText));
  if (parsed.error) {
    throw new Error(readError(context, parsed.error).message);
  }
  const guestContext = parsed.value;
  const signal = scope.manage(context.newObject());
  context.setProp(signal, "aborted", context.false);
  const logFn = scope.manage(
    context.newFunction("log", (...args) => {
      const parts: string[] = [];
      for (const arg of args) {
        parts.push(context.typeof(arg) === "string" ? context.getString(arg) : String(context.dump(arg)));
      }
      logs.append(parts.join(" "));
    }),
  );
  context.setProp(guestContext, "log", logFn);
  context.setProp(guestContext, "signal", signal);
  installCapabilities(context, scope, guestContext, bridge);
  return guestContext;
}

async function settleCall(
  runtime: QuickJSRuntime,
  context: QuickJSContext,
  scope: Scope,
  handle: QuickJSHandle,
  encode: QuickJSHandle,
  request: FunctionChildRequest,
  loaded: LoadedQuickJs,
  logs: LogBuffer,
  bridge: HostBridge,
): Promise<FunctionChildResponse> {
  let executed = 0;
  let current = handle;
  while (executed <= FUNCTION_MAX_PROMISE_JOBS) {
    const state = context.getPromiseState(current);
    if (state.type === "rejected") {
      const failure = failureFromHandle(context, state.error);
      state.error.dispose();
      return withLogs(failure, loaded, logs);
    }
    if (state.type === "fulfilled") {
      const value = state.notAPromise ? current : scope.manage(state.value);
      return withLogs(exportValue(context, scope, encode, value), loaded, logs);
    }
    if (Date.now() >= request.deadlineAt || (request.forceInterrupt && executed > 0)) {
      return withLogs(limitResult("timeout", "function execution timed out"), loaded, logs);
    }
    if (runtime.hasPendingJob() && executed < FUNCTION_MAX_PROMISE_JOBS) {
      const batch = Math.min(32, FUNCTION_MAX_PROMISE_JOBS - executed);
      const pending = runtime.executePendingJobs(batch);
      if (pending.error) {
        const failure = failureFromHandle(context, pending.error);
        pending.dispose();
        return withLogs(failure, loaded, logs);
      }
      const count = pending.value;
      pending.dispose();
      if (count > 0) {
        executed += count;
        continue;
      }
    }
    if (bridge.waiters.length > 0) {
      const waiting = bridge.waiters.splice(0, bridge.waiters.length);
      const remaining = Math.max(0, request.deadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timed = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      const outcome = await Promise.race([Promise.all(waiting).then(() => "done" as const), timed]);
      if (timer) clearTimeout(timer);
      if (outcome === "timeout" || Date.now() >= request.deadlineAt || bridge.closed) {
        return withLogs(limitResult("timeout", "function execution timed out"), loaded, logs);
      }
      continue;
    }
    return withLogs(limitResult("job_limit", "guest promise jobs exceeded the cap"), loaded, logs);
  }
  return withLogs(limitResult("job_limit", "guest promise jobs exceeded the cap"), loaded, logs);
}

function installCapabilities(
  context: QuickJSContext,
  scope: Scope,
  guestContext: QuickJSHandle,
  bridge: HostBridge,
): void {
  const files = scope.manage(context.newObject());
  for (const op of ["exists", "stat", "readText", "readJson"] as const) {
    const fn = scope.manage(
      context.newFunction(op, (rootHandle, pathHandle) =>
        hostPromise(context, bridge, {
          op,
          root: readGuestString(context, rootHandle),
          path: readGuestString(context, pathHandle),
        }),
      ),
    );
    context.setProp(files, op, fn);
  }
  const write = scope.manage(
    context.newFunction("write", (rootHandle, pathHandle, contentHandle) =>
      hostPromise(context, bridge, {
        op: "write",
        root: readGuestString(context, rootHandle),
        path: readGuestString(context, pathHandle),
        content: readGuestString(context, contentHandle),
      }),
    ),
  );
  context.setProp(files, "write", write);
  const http = scope.manage(context.newObject());
  const request = scope.manage(
    context.newFunction("request", (spec) =>
      hostPromise(context, bridge, {
        op: "http",
        method: readGuestProp(context, spec, "method"),
        path: readGuestProp(context, spec, "path"),
        origin: readGuestProp(context, spec, "origin"),
        body: readGuestProp(context, spec, "body"),
      }),
    ),
  );
  context.setProp(http, "request", request);
  context.setProp(guestContext, "files", files);
  context.setProp(guestContext, "http", http);
}

function hostPromise(context: QuickJSContext, bridge: HostBridge, request: CapabilityCall): QuickJSHandle {
  const deferred = context.newPromise();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  bridge.waiters.push(gate);
  void bridge.call(request).then(
    (result) => {
      try {
        if (bridge.closed || !deferred.alive) return;
        if (!result.ok) {
          const error = context.newError({ name: "Error", message: result.message ?? "capability denied" });
          const code = context.newString(result.code ?? "permission_denied");
          context.setProp(error, "code", code);
          code.dispose();
          deferred.reject(error);
          error.dispose();
          return;
        }
        const handle = jsonToHandle(context, result.value ?? null);
        deferred.resolve(handle);
        handle.dispose();
      } catch {
        if (!bridge.closed && deferred.alive) {
          const error = context.newError({ name: "Error", message: "capability failed" });
          deferred.reject(error);
          error.dispose();
        }
      } finally {
        release();
      }
    },
    () => {
      release();
    },
  );
  return deferred.handle;
}

function jsonToHandle(context: QuickJSContext, value: JsonValue): QuickJSHandle {
  const text = context.newString(JSON.stringify(value));
  const json = context.getProp(context.global, "JSON");
  const parse = context.getProp(json, "parse");
  const parsed = context.callFunction(parse, json, text);
  text.dispose();
  parse.dispose();
  json.dispose();
  if (parsed.error) {
    parsed.error.dispose();
    return context.newString("");
  }
  return parsed.value;
}

function readGuestString(context: QuickJSContext, handle: QuickJSHandle | undefined): string | undefined {
  if (!handle || context.typeof(handle) !== "string") return undefined;
  return context.getString(handle);
}

function readGuestProp(context: QuickJSContext, handle: QuickJSHandle | undefined, key: string): string | undefined {
  if (!handle || context.typeof(handle) !== "object") return undefined;
  const prop = context.getProp(handle, key);
  const value = context.typeof(prop) === "string" ? context.getString(prop) : undefined;
  prop.dispose();
  return value;
}

function denyBridge(): HostBridge {
  return {
    waiters: [],
    closed: false,
    receive() {},
    call(input) {
      return Promise.resolve({
        type: "capability_result",
        requestId: input.op,
        ok: false,
        code: "permission_denied",
        message: "capability unavailable",
      });
    },
  };
}

function createIpcBridge(): HostBridge {
  const pending = new Map<string, (result: FunctionCapabilityResult) => void>();
  return {
    waiters: [],
    closed: false,
    receive(message) {
      const resolve = pending.get(message.requestId);
      if (!resolve) return;
      pending.delete(message.requestId);
      resolve(message);
    },
    call(input) {
      const requestId = randomUUID();
      const payload: FunctionCapabilityRequest = { type: "capability", requestId, op: input.op };
      if (input.root !== undefined) payload.root = input.root;
      if (input.path !== undefined) payload.path = input.path;
      if (input.content !== undefined) payload.content = input.content;
      if (input.method !== undefined) payload.method = input.method;
      if (input.origin !== undefined) payload.origin = input.origin;
      if (input.body !== undefined) payload.body = input.body;
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        try {
          const sent = process.send?.(payload) ?? false;
          if (!sent) {
            pending.delete(requestId);
            resolve({
              type: "capability_result",
              requestId,
              ok: false,
              code: "permission_denied",
              message: "capability unavailable",
            });
          }
        } catch {
          pending.delete(requestId);
          resolve({
            type: "capability_result",
            requestId,
            ok: false,
            code: "permission_denied",
            message: "capability unavailable",
          });
        }
      });
    },
  };
}

function exportValue(
  context: QuickJSContext,
  scope: Scope,
  encode: QuickJSHandle,
  value: QuickJSHandle,
): FunctionChildResponse {
  const encoded = scope.manage(context.callFunction(encode, context.undefined, value));
  if (encoded.error) return failureFromHandle(context, encoded.error);
  const jsonHandle = encoded.value;
  const lengthHandle = scope.manage(context.getProp(jsonHandle, "length"));
  const length =
    context.typeof(lengthHandle) === "number"
      ? Number(context.dump(lengthHandle))
      : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(length) || length > FUNCTION_JSON_BYTES_MAX) {
    return limitResult("output_limit", "function output exceeds 256 KiB");
  }
  const json = context.getString(jsonHandle);
  if (Buffer.byteLength(json, "utf8") > FUNCTION_JSON_BYTES_MAX) {
    return limitResult("output_limit", "function output exceeds 256 KiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return limitResult("invalid_output", "function output is not JSON");
  }
  if (parsed === undefined) {
    return limitResult("invalid_output", "function output is not JSON");
  }
  return {
    type: "result",
    ok: true,
    value: parsed as JsonValue,
    logs: "",
    logsTruncated: false,
    disposed: false,
  };
}

function failureFromHandle(context: QuickJSContext, handle: QuickJSHandle): FunctionChildResponse {
  const error = readError(context, handle);
  const codeHandle = context.getProp(handle, "code");
  const explicit = context.typeof(codeHandle) === "string" ? context.getString(codeHandle) : undefined;
  codeHandle.dispose();
  const text = `${error.name}: ${error.message}`;
  let code = "exception";
  if (explicit && EXPLICIT_CODES.has(explicit)) code = explicit;
  else if (error.message.includes("strict-json:")) code = "invalid_output";
  else if (/interrupted/i.test(text)) code = "timeout";
  else if (/out of memory/i.test(text)) code = "memory";
  else if (/stack overflow/i.test(text)) code = "stack";
  return {
    type: "result",
    ok: false,
    code,
    message: text.slice(0, 500),
    logs: "",
    logsTruncated: false,
    disposed: false,
  };
}

function readError(context: QuickJSContext, handle: QuickJSHandle): { name: string; message: string } {
  const nameHandle = context.getProp(handle, "name");
  const messageHandle = context.getProp(handle, "message");
  const name = context.typeof(nameHandle) === "string" ? context.getString(nameHandle) : "Error";
  const message =
    context.typeof(messageHandle) === "string" ? context.getString(messageHandle) : "function execution failed";
  nameHandle.dispose();
  messageHandle.dispose();
  return { name, message };
}

function limitResult(code: string, message: string): FunctionChildResponse {
  return {
    type: "result",
    ok: false,
    code,
    message,
    logs: "",
    logsTruncated: false,
    disposed: false,
  };
}

function withLogs(
  response: FunctionChildResponse,
  loaded: LoadedQuickJs,
  logs: LogBuffer,
): FunctionChildResponse {
  return {
    ...response,
    logs: logs.text(),
    logsTruncated: response.logsTruncated || logs.truncated,
    wasmFile: loaded.wasmFile,
  };
}

function baseResponse(loaded: LoadedQuickJs, logs: LogBuffer): FunctionChildResponse {
  return {
    type: "result",
    ok: false,
    code: "exception",
    message: "function execution failed",
    logs: logs.text(),
    logsTruncated: logs.truncated,
    disposed: false,
    wasmFile: loaded.wasmFile,
  };
}

type LogBuffer = {
  append(text: string): void;
  text(): string;
  truncated: boolean;
};

function createLogBuffer(): LogBuffer {
  let bytes = Buffer.alloc(0);
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    append(text: string) {
      if (truncated) return;
      const next = Buffer.from(text, "utf8");
      const room = FUNCTION_LOG_BYTES_MAX - bytes.byteLength;
      if (next.byteLength > room) {
        if (room > 0) bytes = Buffer.concat([bytes, next.subarray(0, room)]);
        truncated = true;
        return;
      }
      bytes = Buffer.concat([bytes, next]);
    },
    text() {
      return bytes.toString("utf8");
    },
  };
}

async function loadQuickJs(wasm: FunctionWasmVariant): Promise<LoadedQuickJs> {
  const specifier =
    wasm === "debug"
      ? "@jitl/quickjs-wasmfile-debug-sync"
      : "@jitl/quickjs-wasmfile-release-sync";
  const variant = (await import(specifier)).default as Parameters<
    typeof newQuickJSWASMModuleFromVariant
  >[0];
  const module = await newQuickJSWASMModuleFromVariant(variant);
  return {
    module,
    wasm,
    wasmFile: fileURLToPath(import.meta.resolve(`${specifier}/wasm`)),
  };
}

function recoverableLeak(module: QuickJSWASMModule): boolean {
  const ffi = (module as unknown as { getFFI?: () => { QTS_RecoverableLeakCheck?: () => number } }).getFFI?.();
  return Boolean(ffi?.QTS_RecoverableLeakCheck?.());
}

function readRequest(message: unknown): FunctionChildRequest | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Partial<FunctionChildRequest>;
  if (record.type !== "invoke" || typeof record.source !== "string") return undefined;
  if (!record.context || typeof record.context !== "object" || Array.isArray(record.context)) return undefined;
  if (typeof record.deadlineAt !== "number" || typeof record.memoryLimitBytes !== "number") return undefined;
  if (record.wasm !== "release" && record.wasm !== "debug") return undefined;
  return {
    type: "invoke",
    source: record.source,
    context: record.context,
    deadlineAt: record.deadlineAt,
    memoryLimitBytes: record.memoryLimitBytes,
    stackSizeBytes: record.stackSizeBytes === null ? null : (record.stackSizeBytes ?? null),
    forceInterrupt: record.forceInterrupt === true,
    leakHandle: record.leakHandle === true,
    wasm: record.wasm,
  };
}

function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const bridge = createIpcBridge();
  let started = false;
  process.on("message", (message: unknown) => {
    if (isCapabilityResult(message)) {
      bridge.receive(message);
      return;
    }
    if (started) return;
    started = true;
    void runFunctionChild(message, bridge)
      .then((response) => {
        process.send?.(response);
        process.exit(0);
      })
      .catch((error: unknown) => {
        if (isHostStackOverflow(error)) {
          process.kill(process.pid, "SIGKILL");
          return;
        }
        process.send?.({
          type: "result",
          ok: false,
          code: "exception",
          message: errorText(error),
          logs: "",
          logsTruncated: false,
          disposed: false,
        });
        process.exit(1);
      });
  });
}
