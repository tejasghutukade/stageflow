export const FUNCTION_TIMEOUT_MS_DEFAULT = 5_000;
export const FUNCTION_TIMEOUT_MS_MAX = 30_000;
export const FUNCTION_KILL_GRACE_MS = 250;
export const FUNCTION_MEMORY_BYTES_DEFAULT = 16 * 1024 * 1024;
export const FUNCTION_MEMORY_BYTES_MAX = 64 * 1024 * 1024;
export const FUNCTION_STACK_BYTES = 256 * 1024;
export const FUNCTION_SOURCE_BYTES_MAX = 64 * 1024;
export const FUNCTION_JSON_BYTES_MAX = 256 * 1024;
export const FUNCTION_LOG_BYTES_MAX = 16 * 1024;
export const FUNCTION_MAX_RUNNING = 4;
export const FUNCTION_MAX_WAITING = 16;
export const FUNCTION_MAX_PROMISE_JOBS = 1_000;
export const FUNCTION_IO_BYTES_MAX = 1024 * 1024;
export const FUNCTION_HTTP_REDIRECTS_MAX = 3;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type FunctionWasmVariant = "release" | "debug";

export type FunctionInvokeRequest = {
  invocationId: string;
  source: string;
  context: unknown;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  stackSizeBytes?: number | null;
  forceInterrupt?: boolean;
  leakHandle?: boolean;
  wasm?: FunctionWasmVariant;
};

export type FunctionInvokeResult = {
  ok: boolean;
  value?: JsonValue;
  logs: string;
  logsTruncated: boolean;
  code?: string;
  message?: string;
  pid?: number;
  disposed?: boolean;
  wasmFile?: string;
};

export type FunctionChildRequest = {
  type: "invoke";
  source: string;
  context: JsonObject;
  deadlineAt: number;
  memoryLimitBytes: number;
  stackSizeBytes: number | null;
  forceInterrupt: boolean;
  leakHandle: boolean;
  wasm: FunctionWasmVariant;
};

export type FunctionChildResponse = {
  type: "result";
  ok: boolean;
  value?: JsonValue;
  logs: string;
  logsTruncated: boolean;
  code?: string;
  message?: string;
  disposed: boolean;
  wasmFile?: string;
};

export type JsonCheck =
  | { ok: true; value: JsonValue }
  | { ok: false; message: string };

export function assertJsonValue(value: unknown): JsonCheck {
  return assertJsonValueSeen(value, new WeakSet());
}

export function assertJsonObject(value: unknown): { ok: true; value: JsonObject } | { ok: false; message: string } {
  const checked = assertJsonValue(value);
  if (!checked.ok) return checked;
  if (checked.value === null || Array.isArray(checked.value) || typeof checked.value !== "object") {
    return { ok: false, message: "context must be a JSON object" };
  }
  return { ok: true, value: checked.value };
}

export function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export type FunctionKind = "verification" | "routing" | "tool";

export type FunctionFileRoot = "artifacts" | "workspace";

export type FunctionCapabilityOp = "exists" | "stat" | "readText" | "readJson" | "write" | "http";

export type FunctionCapabilityRequest = {
  type: "capability";
  requestId: string;
  op: FunctionCapabilityOp;
  root?: string;
  path?: string;
  content?: string;
  method?: string;
  origin?: string;
  body?: string;
};

export type FunctionCapabilityResult = {
  type: "capability_result";
  requestId: string;
  ok: boolean;
  value?: JsonValue;
  code?: string;
  message?: string;
};

const CAPABILITY_OPS = new Set<FunctionCapabilityOp>(["exists", "stat", "readText", "readJson", "write", "http"]);

export function isCapabilityRequest(value: unknown): value is FunctionCapabilityRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<FunctionCapabilityRequest>;
  return (
    record.type === "capability" &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    record.requestId.length <= 80 &&
    typeof record.op === "string" &&
    CAPABILITY_OPS.has(record.op)
  );
}

export function isCapabilityResult(value: unknown): value is FunctionCapabilityResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<FunctionCapabilityResult>;
  return record.type === "capability_result" && typeof record.requestId === "string" && typeof record.ok === "boolean";
}

export function isChildResponse(value: unknown): value is FunctionChildResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as { type?: unknown; ok?: unknown; logs?: unknown };
  return record.type === "result" && typeof record.ok === "boolean" && typeof record.logs === "string";
}

function assertJsonValueSeen(value: unknown, seen: WeakSet<object>): JsonCheck {
  if (value === undefined) return { ok: false, message: "undefined is not JSON" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, message: "non-finite number is not JSON" };
    return { ok: true, value };
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return { ok: true, value };
  }
  if (typeof value === "bigint") return { ok: false, message: "bigint is not JSON" };
  if (typeof value === "function" || typeof value === "symbol") {
    return { ok: false, message: `${typeof value} is not JSON` };
  }
  if (typeof value !== "object") return { ok: false, message: "value is not JSON" };
  if (seen.has(value)) return { ok: false, message: "cyclic value is not JSON" };
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return { ok: false, message: "class instance is not JSON" };
    }
    const items: JsonValue[] = [];
    for (const item of value) {
      const checked = assertJsonValueSeen(item, seen);
      if (!checked.ok) return checked;
      items.push(checked.value);
    }
    return { ok: true, value: items };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, message: "class instance is not JSON" };
  }
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    const checked = assertJsonValueSeen((value as Record<string, unknown>)[key], seen);
    if (!checked.ok) return checked;
    out[key] = checked.value;
  }
  return { ok: true, value: out };
}
