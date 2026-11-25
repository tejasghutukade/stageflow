export const BRIDGE_PROTOCOL_VERSION = "2026-01-26";

export const MAX_MESSAGE_BYTES = 256 * 1024;

export const MAX_INFLIGHT_REQUESTS = 100;

export const MAX_LINK_HREF_CHARS = 200;

export const MAX_FRAME_HEIGHT_PX = 4000;

export const MAX_FRAME_WIDTH_PX = 8192;

export const BRIDGE_METHODS = [
  "ui/initialize",
  "ui/notifications/initialized",
  "ui/notifications/size-changed",
  "ui/notifications/host-context-changed",
  "ui/notifications/link-blocked",
  "ui/notifications/binding-updated",
  "tools/call",
  "ping",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

const REQUEST_METHODS = new Set<BridgeMethod>(["ui/initialize", "tools/call", "ping"]);

const NOTIFICATION_METHODS = new Set<BridgeMethod>([
  "ui/notifications/initialized",
  "ui/notifications/size-changed",
  "ui/notifications/host-context-changed",
  "ui/notifications/link-blocked",
  "ui/notifications/binding-updated",
]);

export const HOST_CONTEXT_VARIABLES = [
  "--sf-ground",
  "--sf-panel",
  "--sf-raised",
  "--sf-text-1",
  "--sf-text-2",
  "--sf-text-3",
  "--sf-hairline",
  "--sf-running",
  "--sf-ok",
  "--sf-needs",
  "--sf-fail",
  "--sf-font-ui",
  "--sf-font-mono",
] as const;

export type HostContextVariable = (typeof HOST_CONTEXT_VARIABLES)[number];

const VARIABLE_NAMES = new Set<string>(HOST_CONTEXT_VARIABLES);

export const BRIDGE_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export type BridgeId = string | number;

export type BridgeErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type BridgeRequest = {
  jsonrpc: "2.0";
  id: BridgeId;
  method: BridgeMethod;
  params?: unknown;
};

export type BridgeNotification = {
  jsonrpc: "2.0";
  method: BridgeMethod;
  params?: unknown;
};

export type BridgeSuccess = {
  jsonrpc: "2.0";
  id: BridgeId;
  result: unknown;
};

export type BridgeFailure = {
  jsonrpc: "2.0";
  id: BridgeId;
  error: BridgeErrorObject;
};

export type BridgeMessage = BridgeRequest | BridgeNotification | BridgeSuccess | BridgeFailure;

export type BridgeParseResult =
  | { ok: true; message: BridgeMessage }
  | { ok: false; error: { code: number; message: string; id: BridgeId | null } };

const BINDING_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_ID = /^[\x20-\x7e]{1,64}$/;
export const BINDING_UPDATED_ID = /^[a-z][a-z0-9_]{0,31}$/;

const utf8 = new TextEncoder();

export function bridgeMessageBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  return parseBridgeMessage(value).ok;
}

export function parseBridgeMessage(value: unknown): BridgeParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "Message must be a JSON object", null);
  }
  let bytes: number;
  try {
    bytes = bridgeMessageBytes(value);
  } catch {
    return fail(BRIDGE_ERROR.PARSE, "Message is not JSON", null);
  }
  if (bytes > MAX_MESSAGE_BYTES) {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "Message exceeds 256 KiB", idOf(value));
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "jsonrpc must be 2.0", idOf(record));
  }
  const keys = Object.keys(record);
  if (keys.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "Unsupported field", idOf(record));
  }
  const hasMethod = Object.prototype.hasOwnProperty.call(record, "method");
  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");
  const hasId = Object.prototype.hasOwnProperty.call(record, "id");
  const hasParams = Object.prototype.hasOwnProperty.call(record, "params");
  if (hasResult && hasError) {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "result and error are mutually exclusive", idOf(record));
  }
  if ((hasResult || hasError) && (hasMethod || hasParams)) {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "A response cannot include method or params", idOf(record));
  }
  if (hasResult || hasError) {
    if (!hasId) return fail(BRIDGE_ERROR.INVALID_REQUEST, "Response id is required", null);
    const id = parseId(record.id);
    if (!id.ok) return fail(BRIDGE_ERROR.INVALID_REQUEST, id.message, null);
    const allowed = new Set(["jsonrpc", "id", hasResult ? "result" : "error"]);
    if (keys.some((key) => !allowed.has(key))) {
      return fail(BRIDGE_ERROR.INVALID_REQUEST, "Unsupported field", id.id);
    }
    if (hasError) {
      const error = parseErrorObject(record.error);
      if (!error.ok) return fail(BRIDGE_ERROR.INVALID_REQUEST, error.message, id.id);
      return { ok: true, message: { jsonrpc: "2.0", id: id.id, error: error.error } };
    }
    if (!isJsonValue(record.result, 0)) {
      return fail(BRIDGE_ERROR.INVALID_REQUEST, "result is not JSON", id.id);
    }
    return { ok: true, message: { jsonrpc: "2.0", id: id.id, result: record.result } };
  }
  if (!hasMethod || typeof record.method !== "string") {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "method is required", idOf(record));
  }
  if (!BRIDGE_METHODS.includes(record.method as BridgeMethod)) {
    return fail(BRIDGE_ERROR.METHOD_NOT_FOUND, "Method not found", idOf(record));
  }
  const method = record.method as BridgeMethod;
  const allowed = new Set(["jsonrpc", "method"]);
  if (hasId) allowed.add("id");
  if (hasParams) allowed.add("params");
  if (keys.some((key) => !allowed.has(key))) {
    return fail(BRIDGE_ERROR.INVALID_REQUEST, "Unsupported field", idOf(record));
  }
  if (REQUEST_METHODS.has(method)) {
    if (!hasId) return fail(BRIDGE_ERROR.INVALID_REQUEST, "Request id is required", null);
    const id = parseId(record.id);
    if (!id.ok) return fail(BRIDGE_ERROR.INVALID_REQUEST, id.message, null);
    const params = checkParams(method, hasParams ? record.params : undefined, hasParams);
    if (!params.ok) return fail(BRIDGE_ERROR.INVALID_PARAMS, params.message, id.id);
    const message: BridgeRequest = { jsonrpc: "2.0", id: id.id, method };
    if (hasParams) message.params = record.params;
    return { ok: true, message };
  }
  if (!NOTIFICATION_METHODS.has(method)) {
    return fail(BRIDGE_ERROR.METHOD_NOT_FOUND, "Method not found", idOf(record));
  }
  if (hasId) return fail(BRIDGE_ERROR.INVALID_REQUEST, "A notification cannot include id", idOf(record));
  const params = checkParams(method, hasParams ? record.params : undefined, hasParams);
  if (!params.ok) return fail(BRIDGE_ERROR.INVALID_PARAMS, params.message, null);
  const message: BridgeNotification = { jsonrpc: "2.0", method };
  if (hasParams) message.params = record.params;
  return { ok: true, message };
}

export function buildBindingUpdated(bindingId: string): BridgeNotification {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/binding-updated",
    params: { binding_id: bindingId },
  };
}

export function bridgeResult(id: BridgeId, result: unknown): BridgeSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function bridgeError(id: BridgeId | null, code: number, message: string, data?: unknown): BridgeFailure | {
  jsonrpc: "2.0";
  id: null;
  error: BridgeErrorObject;
} {
  const error: BridgeErrorObject = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: "2.0", id, error };
}

export type HostContext = {
  theme: "dark" | "light";
  styles: {
    variables: Partial<Record<HostContextVariable, string>>;
    css?: Record<string, string>;
  };
  displayMode: "inline";
  availableDisplayModes: ["inline"];
  containerDimensions: { maxWidth?: number };
  locale?: string;
  timeZone?: string;
  platform: "web";
};

export function buildInitializeResult(input: {
  id: BridgeId;
  version: string;
  csp: string;
  hostContext: HostContext;
}): BridgeSuccess {
  return bridgeResult(input.id, {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    hostInfo: { name: "stageflow", version: input.version },
    hostCapabilities: {
      tools: { call: true },
      sandbox: { permissions: {}, csp: input.csp },
    },
    hostContext: input.hostContext,
  });
}

export function validateInitializeResult(result: unknown): boolean {
  if (!isPlain(result)) return false;
  if (result.protocolVersion !== BRIDGE_PROTOCOL_VERSION) return false;
  if (!exactKeys(result, ["protocolVersion", "hostInfo", "hostCapabilities", "hostContext"])) return false;
  if (!isPlain(result.hostInfo) || result.hostInfo.name !== "stageflow") return false;
  if (typeof result.hostInfo.version !== "string" || result.hostInfo.version.length === 0 || result.hostInfo.version.length > 32) {
    return false;
  }
  if (!exactKeys(result.hostInfo, ["name", "version"])) return false;
  const caps = result.hostCapabilities;
  if (!isPlain(caps) || !exactKeys(caps, ["tools", "sandbox"])) return false;
  if (!isPlain(caps.tools) || caps.tools.call !== true || !exactKeys(caps.tools, ["call"])) return false;
  if (!isPlain(caps.sandbox) || !exactKeys(caps.sandbox, ["permissions", "csp"])) return false;
  if (!isPlain(caps.sandbox.permissions) || Object.keys(caps.sandbox.permissions).length !== 0) return false;
  if (typeof caps.sandbox.csp !== "string" || caps.sandbox.csp.length > 8192) return false;
  return validateHostContext(result.hostContext);
}

export function validateToolsCallResult(result: unknown): boolean {
  if (!isPlain(result)) return false;
  if (!exactKeys(result, ["content", "structuredContent", "isError", "_meta"]) && !exactKeys(result, ["content", "structuredContent", "_meta"])) {
    return false;
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) return false;
  const block = result.content[0];
  if (!isPlain(block) || block.type !== "text" || typeof block.text !== "string" || !exactKeys(block, ["type", "text"])) {
    return false;
  }
  if (!isJsonValue(result.structuredContent, 0)) return false;
  if (Object.prototype.hasOwnProperty.call(result, "isError") && typeof result.isError !== "boolean") return false;
  if (!isPlain(result._meta)) return false;
  const metaKeys = Object.keys(result._meta);
  if (metaKeys.some((key) => key !== "source" && key !== "fetched_at" && key !== "retryable")) return false;
  if (!Object.prototype.hasOwnProperty.call(result._meta, "source") || !Object.prototype.hasOwnProperty.call(result._meta, "fetched_at")) {
    return false;
  }
  if (result._meta.source !== "cache" && result._meta.source !== "executed") return false;
  if (Object.prototype.hasOwnProperty.call(result._meta, "retryable") && typeof result._meta.retryable !== "boolean") return false;
  return typeof result._meta.fetched_at === "string" && result._meta.fetched_at.length > 0 && result._meta.fetched_at.length <= 64;
}

export function validateHostContext(value: unknown): value is HostContext {
  if (!isPlain(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([
    "theme",
    "styles",
    "displayMode",
    "availableDisplayModes",
    "containerDimensions",
    "locale",
    "timeZone",
    "platform",
  ]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (value.theme !== "dark" && value.theme !== "light") return false;
  if (value.displayMode !== "inline" || value.platform !== "web") return false;
  if (!Array.isArray(value.availableDisplayModes) || value.availableDisplayModes.length !== 1 || value.availableDisplayModes[0] !== "inline") {
    return false;
  }
  if (!isPlain(value.styles) || !isPlain(value.styles.variables)) return false;
  const styleKeys = Object.keys(value.styles);
  if (styleKeys.some((key) => key !== "variables" && key !== "css")) return false;
  if (!variablesOk(value.styles.variables)) return false;
  if (Object.prototype.hasOwnProperty.call(value.styles, "css")) {
    if (!isPlain(value.styles.css)) return false;
    const cssKeys = Object.keys(value.styles.css);
    if (cssKeys.length > 20) return false;
    for (const key of cssKeys) {
      if (!/^[a-z0-9-]{1,64}$/.test(key)) return false;
      if (typeof value.styles.css[key] !== "string" || !cssValueOk(value.styles.css[key])) return false;
    }
  }
  if (!isPlain(value.containerDimensions)) return false;
  const dimKeys = Object.keys(value.containerDimensions);
  if (dimKeys.some((key) => key !== "maxWidth")) return false;
  if (Object.prototype.hasOwnProperty.call(value.containerDimensions, "maxWidth") && !dimension(value.containerDimensions.maxWidth, 100_000)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, "locale") && !shortText(value.locale, 64)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "timeZone") && !shortText(value.timeZone, 64)) return false;
  return true;
}

function checkParams(method: BridgeMethod, params: unknown, present: boolean): { ok: true } | { ok: false; message: string } {
  if (method === "ping" || method === "ui/notifications/initialized") {
    if (!present) return { ok: true };
    if (!isPlain(params) || Object.keys(params).length !== 0) return { ok: false, message: "params must be an empty object" };
    return { ok: true };
  }
  if (method === "ui/initialize") {
    if (!isPlain(params)) return { ok: false, message: "params are required" };
    if (!exactKeys(params, ["protocolVersion", "appInfo", "appCapabilities"])) {
      return { ok: false, message: "Unexpected initialize params" };
    }
    if (params.protocolVersion !== BRIDGE_PROTOCOL_VERSION) return { ok: false, message: "Unsupported protocolVersion" };
    if (!isPlain(params.appInfo) || !exactKeys(params.appInfo, ["name", "version"])) {
      return { ok: false, message: "appInfo is invalid" };
    }
    if (!shortText(params.appInfo.name, 128) || !shortText(params.appInfo.version, 64)) {
      return { ok: false, message: "appInfo is invalid" };
    }
    if (!isPlain(params.appCapabilities)) return { ok: false, message: "appCapabilities is invalid" };
    const capKeys = Object.keys(params.appCapabilities);
    if (capKeys.some((key) => key !== "availableDisplayModes")) return { ok: false, message: "appCapabilities is invalid" };
    if (Object.prototype.hasOwnProperty.call(params.appCapabilities, "availableDisplayModes")) {
      const modes = params.appCapabilities.availableDisplayModes;
      if (!Array.isArray(modes) || modes.length > 4) return { ok: false, message: "availableDisplayModes is invalid" };
      if (modes.some((mode) => typeof mode !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(mode))) {
        return { ok: false, message: "availableDisplayModes is invalid" };
      }
    }
    return { ok: true };
  }
  if (method === "tools/call") {
    if (!isPlain(params) || !Object.prototype.hasOwnProperty.call(params, "name")) {
      return { ok: false, message: "tools/call requires name" };
    }
    const keys = Object.keys(params);
    if (keys.some((key) => key !== "name" && key !== "arguments")) return { ok: false, message: "Unexpected tools/call params" };
    if (typeof params.name !== "string" || !BINDING_ID.test(params.name)) return { ok: false, message: "binding id is invalid" };
    if (Object.prototype.hasOwnProperty.call(params, "arguments")) {
      if (!jsonObject(params.arguments, 0, 16)) return { ok: false, message: "arguments are invalid" };
    }
    return { ok: true };
  }
  if (method === "ui/notifications/size-changed") {
    if (!isPlain(params)) return { ok: false, message: "size params are required" };
    const keys = Object.keys(params);
    if (keys.length === 0 || keys.some((key) => key !== "width" && key !== "height")) {
      return { ok: false, message: "size params are invalid" };
    }
    if (Object.prototype.hasOwnProperty.call(params, "width") && !dimension(params.width, MAX_FRAME_WIDTH_PX)) {
      return { ok: false, message: "width is invalid" };
    }
    if (Object.prototype.hasOwnProperty.call(params, "height") && !dimension(params.height, MAX_FRAME_HEIGHT_PX)) {
      return { ok: false, message: "height is invalid" };
    }
    return { ok: true };
  }
  if (method === "ui/notifications/link-blocked") {
    if (!present) return { ok: true };
    if (!isPlain(params)) return { ok: false, message: "link params are invalid" };
    const keys = Object.keys(params);
    if (keys.some((key) => key !== "href")) return { ok: false, message: "link params are invalid" };
    if (Object.prototype.hasOwnProperty.call(params, "href")) {
      if (typeof params.href !== "string" || params.href.length > MAX_LINK_HREF_CHARS) {
        return { ok: false, message: "href is invalid" };
      }
    }
    return { ok: true };
  }
  if (method === "ui/notifications/binding-updated") {
    if (!isPlain(params) || !exactKeys(params, ["binding_id"])) return { ok: false, message: "binding_id is required" };
    if (typeof params.binding_id !== "string" || !BINDING_UPDATED_ID.test(params.binding_id)) {
      return { ok: false, message: "binding_id is invalid" };
    }
    return { ok: true };
  }
  if (!isPlain(params)) return { ok: false, message: "host context params are required" };
  const keys = Object.keys(params);
  const allowed = new Set(["theme", "styles", "displayMode", "containerDimensions"]);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) return { ok: false, message: "host context params are invalid" };
  if (Object.prototype.hasOwnProperty.call(params, "theme") && params.theme !== "dark" && params.theme !== "light") {
    return { ok: false, message: "theme is invalid" };
  }
  if (Object.prototype.hasOwnProperty.call(params, "displayMode") && params.displayMode !== "inline") {
    return { ok: false, message: "displayMode is invalid" };
  }
  if (Object.prototype.hasOwnProperty.call(params, "styles")) {
    if (!isPlain(params.styles) || !isPlain(params.styles.variables)) return { ok: false, message: "styles are invalid" };
    if (!variablesOk(params.styles.variables)) return { ok: false, message: "styles are invalid" };
    const styleKeys = Object.keys(params.styles);
    if (styleKeys.some((key) => key !== "variables" && key !== "css")) return { ok: false, message: "styles are invalid" };
  }
  if (Object.prototype.hasOwnProperty.call(params, "containerDimensions")) {
    if (!isPlain(params.containerDimensions)) return { ok: false, message: "containerDimensions are invalid" };
    const dimKeys = Object.keys(params.containerDimensions);
    if (dimKeys.some((key) => key !== "maxWidth" && key !== "width" && key !== "height")) {
      return { ok: false, message: "containerDimensions are invalid" };
    }
  }
  return { ok: true };
}

function variablesOk(value: Record<string, unknown>): boolean {
  for (const key of Object.keys(value)) {
    if (!VARIABLE_NAMES.has(key)) return false;
    if (typeof value[key] !== "string" || !cssValueOk(value[key])) return false;
  }
  return true;
}

function cssValueOk(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return !value.includes("<") && !value.includes(">") && !value.includes("{") && !value.includes("}");
}

export const TOOLS_CALL_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const TOOLS_CALL_MAX_ARGUMENT_KEYS = 16;

export function validateToolsCallArguments(
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  const checked = validateJsonObjectArgs(value, 0, TOOLS_CALL_MAX_ARGUMENT_KEYS);
  return checked.ok ? { ok: true } : { ok: false, message: checked.message };
}

function validateJsonObjectArgs(
  value: unknown,
  depth: number,
  maxKeys: number,
): { ok: true } | { ok: false; message: string } {
  if (!isPlain(value) || depth > 8) return { ok: false, message: "arguments are invalid" };
  const keys = Object.keys(value);
  if (keys.length > maxKeys) return { ok: false, message: "too many argument keys" };
  for (const key of keys) {
    if (!TOOLS_CALL_ARG_KEY.test(key)) {
      return { ok: false, message: `invalid argument key "${key}"` };
    }
    const field = value[key];
    if (field === undefined) {
      return { ok: false, message: `invalid argument value for "${key}"` };
    }
    const nested = validateJsonArgValue(field, depth + 1);
    if (!nested.ok) return nested;
  }
  return { ok: true };
}

function validateJsonArgValue(value: unknown, depth: number): { ok: true } | { ok: false; message: string } {
  if (depth > 32) return { ok: false, message: "arguments are too deeply nested" };
  if (value === null) return { ok: true };
  const kind = typeof value;
  if (kind === "string") {
    return (value as string).length <= MAX_MESSAGE_BYTES ? { ok: true } : { ok: false, message: "argument string is too large" };
  }
  if (kind === "boolean") return { ok: true };
  if (kind === "number") {
    return Number.isFinite(value) ? { ok: true } : { ok: false, message: "argument number is not finite" };
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) return { ok: false, message: "argument array is too large" };
    for (const item of value) {
      const nested = validateJsonArgValue(item, depth + 1);
      if (!nested.ok) return nested;
    }
    return { ok: true };
  }
  if (!isPlain(value)) return { ok: false, message: "arguments are invalid" };
  const keys = Object.keys(value);
  if (keys.length > 1000) return { ok: false, message: "too many argument keys" };
  return validateJsonObjectArgs(value, depth, 1000);
}

function jsonObject(value: unknown, depth: number, maxKeys: number): boolean {
  return validateJsonObjectArgs(value, depth, maxKeys).ok;
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string") return (value as string).length <= MAX_MESSAGE_BYTES;
  if (kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (value.length > 1000) return false;
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isPlain(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > 1000) return false;
  return keys.every((key) => isJsonValue(value[key], depth + 1));
}

function dimension(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

function shortText(value: unknown, max: number): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function parseId(value: unknown): { ok: true; id: BridgeId } | { ok: false; message: string } {
  if (typeof value === "number" && Number.isSafeInteger(value)) return { ok: true, id: value };
  if (typeof value === "string" && SAFE_ID.test(value)) return { ok: true, id: value };
  return { ok: false, message: "id must be a safe integer or a string of at most 64 characters" };
}

function parseErrorObject(value: unknown): { ok: true; error: BridgeErrorObject } | { ok: false; message: string } {
  if (!isPlain(value) || typeof value.code !== "number" || !Number.isInteger(value.code)) {
    return { ok: false, message: "error.code is required" };
  }
  if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 256) {
    return { ok: false, message: "error.message is required" };
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "code" && key !== "message" && key !== "data")) {
    return { ok: false, message: "error has an unsupported field" };
  }
  if (Object.prototype.hasOwnProperty.call(value, "data") && !isJsonValue(value.data, 0)) {
    return { ok: false, message: "error.data is not JSON" };
  }
  const error: BridgeErrorObject = { code: value.code, message: value.message };
  if (Object.prototype.hasOwnProperty.call(value, "data")) error.data = value.data;
  return { ok: true, error };
}

function idOf(value: object): BridgeId | null {
  if (!Object.prototype.hasOwnProperty.call(value, "id")) return null;
  const id = parseId((value as { id: unknown }).id);
  return id.ok ? id.id : null;
}

function fail(code: number, message: string, id: BridgeId | null): BridgeParseResult {
  return { ok: false, error: { code, message, id } };
}

function isPlain(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(value);
  if (present.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function parseSandboxLoadParams(value: unknown):
  | { ok: true; load: { html: string; csp: string; nonce: string; libraries: { name: string; version: string }[]; allowEval: boolean } }
  | { ok: false } {
  if (!isPlain(value)) return { ok: false };
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "html" && key !== "csp" && key !== "nonce" && key !== "libraries" && key !== "allowEval") return { ok: false };
  }
  if (typeof value.html !== "string" || typeof value.csp !== "string" || typeof value.nonce !== "string") return { ok: false };
  if (!/^[0-9a-fA-F]{32}$/.test(value.nonce)) return { ok: false };
  let allowEval = false;
  if (Object.prototype.hasOwnProperty.call(value, "allowEval")) {
    if (typeof value.allowEval !== "boolean") return { ok: false };
    allowEval = value.allowEval;
  }
  const libraries: { name: string; version: string }[] = [];
  if (Object.prototype.hasOwnProperty.call(value, "libraries")) {
    const listed = value.libraries;
    if (!Array.isArray(listed) || listed.length > 6) return { ok: false };
    const seen = new Set<string>();
    for (const entry of listed) {
      if (!isPlain(entry) || !exactKeys(entry, ["name", "version"])) return { ok: false };
      if (typeof entry.name !== "string" || typeof entry.version !== "string") return { ok: false };
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(entry.name) || !/^\d+\.\d+\.\d+$/.test(entry.version)) return { ok: false };
      if (seen.has(entry.name)) return { ok: false };
      seen.add(entry.name);
      libraries.push({ name: entry.name, version: entry.version });
    }
  }
  return { ok: true, load: { html: value.html, csp: value.csp, nonce: value.nonce, libraries, allowEval } };
}

export function bridgeRuntimeSource(): string {
  return [
    `var BRIDGE_PROTOCOL_VERSION = ${JSON.stringify(BRIDGE_PROTOCOL_VERSION)};`,
    `var MAX_MESSAGE_BYTES = ${MAX_MESSAGE_BYTES};`,
    `var MAX_LINK_HREF_CHARS = ${MAX_LINK_HREF_CHARS};`,
    `var MAX_FRAME_HEIGHT_PX = ${MAX_FRAME_HEIGHT_PX};`,
    `var MAX_FRAME_WIDTH_PX = ${MAX_FRAME_WIDTH_PX};`,
    `var BRIDGE_METHODS = ${JSON.stringify(BRIDGE_METHODS)};`,
    `var REQUEST_METHODS = new Set(${JSON.stringify([...REQUEST_METHODS])});`,
    `var NOTIFICATION_METHODS = new Set(${JSON.stringify([...NOTIFICATION_METHODS])});`,
    `var HOST_CONTEXT_VARIABLES = ${JSON.stringify([...HOST_CONTEXT_VARIABLES])};`,
    `var VARIABLE_NAMES = new Set(HOST_CONTEXT_VARIABLES);`,
    `var BRIDGE_ERROR = ${JSON.stringify(BRIDGE_ERROR)};`,
    `var BINDING_ID = ${BINDING_ID.toString()};`,
    `var SAFE_ID = ${SAFE_ID.toString()};`,
    `var BINDING_UPDATED_ID = ${BINDING_UPDATED_ID.toString()};`,
    `var TOOLS_CALL_ARG_KEY = ${TOOLS_CALL_ARG_KEY.toString()};`,
    `var TOOLS_CALL_MAX_ARGUMENT_KEYS = ${TOOLS_CALL_MAX_ARGUMENT_KEYS};`,
    `var utf8 = new TextEncoder();`,
    bridgeMessageBytes.toString(),
    isBridgeMessage.toString(),
    parseBridgeMessage.toString(),
    checkParams.toString(),
    variablesOk.toString(),
    cssValueOk.toString(),
    validateJsonArgValue.toString(),
    validateJsonObjectArgs.toString(),
    jsonObject.toString(),
    isJsonValue.toString(),
    dimension.toString(),
    shortText.toString(),
    parseId.toString(),
    parseErrorObject.toString(),
    idOf.toString(),
    fail.toString(),
    isPlain.toString(),
    exactKeys.toString(),
    parseSandboxLoadParams.toString(),
  ].join("\n");
}
