import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BINDING_UPDATED_ID,
  BRIDGE_ERROR,
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  HOST_CONTEXT_VARIABLES,
  MAX_MESSAGE_BYTES,
  bridgeError,
  bridgeResult,
  bridgeRuntimeSource,
  buildBindingUpdated,
  buildInitializeResult,
  parseBridgeMessage,
  validateHostContext,
  validateInitializeResult,
  validateToolsCallArguments,
  validateToolsCallResult,
  MAX_FRAME_WIDTH_PX,
} from "../src/artifacts/bridge/protocol.js";

const initParams = {
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  appInfo: { name: "live-html", version: "1" },
  appCapabilities: { availableDisplayModes: ["inline"] },
};

const hostContext = {
  theme: "dark" as const,
  styles: { variables: { "--sf-ground": "#0c0d0f", "--sf-text-1": "#ecedee", "--sf-ok": "#4cc38a" } },
  displayMode: "inline" as const,
  availableDisplayModes: ["inline"] as ["inline"],
  containerDimensions: { maxWidth: 640 },
  platform: "web" as const,
};

function request(method: string, params?: unknown, id: string | number = 1) {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

describe("bridge protocol", () => {
  it("lists the host CSS variables", () => {
    expect(HOST_CONTEXT_VARIABLES).toEqual([
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
    ]);
    expect(MAX_MESSAGE_BYTES).toBe(256 * 1024);
  });

  it("accepts each method and rejects a bad twin", () => {
    const cases: Array<{ value: unknown; ok: boolean; code?: number }> = [
      { value: request("ping"), ok: true },
      { value: request("ping", {}), ok: true },
      { value: request("ping", { extra: 1 }), ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/notifications/initialized" }, ok: true },
      { value: { jsonrpc: "2.0", id: 1, method: "ui/notifications/initialized" }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: request("ui/initialize", initParams, "init-1"), ok: true },
      { value: request("ui/initialize", { ...initParams, protocolVersion: "nope" }), ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: request("ui/initialize", { ...initParams, token: "x" }), ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/initialize", params: initParams }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: request("tools/call", { name: "kpi.summary", arguments: { range: "7d" } }, "call-1"), ok: true },
      { value: request("tools/call", { name: "kpi.summary" }), ok: true },
      { value: request("tools/call", { name: "" }), ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: request("tools/call", { name: "kpi.summary", arguments: [] }), ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 640, height: 160 } }, ok: true },
      { value: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 4000 } }, ok: true },
      { value: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 4001 } }, ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: {} }, ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/notifications/link-blocked" }, ok: true },
      { value: { jsonrpc: "2.0", method: "ui/notifications/link-blocked", params: { href: "https://example.com" } }, ok: true },
      { value: { jsonrpc: "2.0", method: "ui/notifications/link-blocked", params: { href: "x".repeat(201) } }, ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "rows" } }, ok: true },
      { value: { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "a".repeat(32) } }, ok: true },
      { value: { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "Rows" } }, ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "" } }, ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "a".repeat(33) } }, ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: { jsonrpc: "2.0", id: 1, method: "ui/notifications/binding-updated", params: { binding_id: "rows" } }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark", styles: { variables: { "--sf-ground": "#0c0d0f" } } } }, ok: true },
      { value: { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { styles: { variables: { "--sf-evil": "red" } } } }, ok: false, code: BRIDGE_ERROR.INVALID_PARAMS },
      { value: request("system/secret"), ok: false, code: BRIDGE_ERROR.METHOD_NOT_FOUND },
      { value: { jsonrpc: "1.0", id: 1, method: "ping" }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: { jsonrpc: "2.0", id: "", method: "ping" }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: { jsonrpc: "2.0", id: "x".repeat(65), method: "ping" }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: { jsonrpc: "2.0", id: 1.5, method: "ping" }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: { jsonrpc: "2.0", id: 1, method: "ping", result: {} }, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: null, ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
      { value: [], ok: false, code: BRIDGE_ERROR.INVALID_REQUEST },
    ];
    for (const entry of cases) {
      const parsed = parseBridgeMessage(entry.value);
      expect(parsed.ok).toBe(entry.ok);
      if (!parsed.ok && entry.code !== undefined) expect(parsed.error.code).toBe(entry.code);
    }
  });

  it("rejects an oversized message and builds results", () => {
    const huge = { jsonrpc: "2.0", id: 1, method: "ping", params: { blob: "x".repeat(MAX_MESSAGE_BYTES) } };
    const parsed = parseBridgeMessage(huge);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe(BRIDGE_ERROR.INVALID_REQUEST);
    const init = buildInitializeResult({ id: "init-1", version: "0.0.0", csp: "default-src 'none'", hostContext });
    expect(validateInitializeResult(init.result)).toBe(true);
    expect(validateHostContext(hostContext)).toBe(true);
    expect(validateHostContext({ ...hostContext, theme: "blue" })).toBe(false);
    const call = bridgeResult("call-1", {
      content: [{ type: "text", text: "{\"value\":42}" }],
      structuredContent: { value: 42 },
      isError: false,
      _meta: { source: "cache", fetched_at: "2026-11-25T00:00:00.000Z" },
    });
    expect(parseBridgeMessage(call).ok).toBe(true);
    expect(validateToolsCallResult(call.result)).toBe(true);
    expect(validateToolsCallResult({
      ...(call.result as object),
      _meta: { source: "cache", fetched_at: "2026-11-25T00:00:00.000Z", retryable: true },
    })).toBe(true);
    expect(validateToolsCallResult({
      ...(call.result as object),
      _meta: { source: "executed", fetched_at: "2026-11-25T00:00:00.000Z", retryable: "yes" },
    })).toBe(false);
    expect(validateToolsCallResult({ ...call.result as object, _meta: { source: "network", fetched_at: "t" } })).toBe(false);
    const updated = buildBindingUpdated("rows");
    expect(parseBridgeMessage(updated).ok).toBe(true);
    expect(BINDING_UPDATED_ID.test("rows")).toBe(true);
    expect(BRIDGE_METHODS).toContain("ui/notifications/binding-updated");
    expect(bridgeRuntimeSource()).toContain("function parseBridgeMessage");
    const failure = bridgeError("call-1", BRIDGE_ERROR.METHOD_NOT_FOUND, "Method not found");
    expect(parseBridgeMessage(failure).ok).toBe(true);
    expect(parseBridgeMessage({ jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } }).ok).toBe(false);
  });

  it("validates tools/call arguments", () => {
    expect(validateToolsCallArguments(undefined).ok).toBe(true);
    expect(validateToolsCallArguments({ range: "7d" }).ok).toBe(true);
    const badKey = validateToolsCallArguments({ "img-element": 1 });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.message).toBe('invalid argument key "img-element"');
    expect(validateToolsCallArguments({ bad: undefined }).ok).toBe(false);
    expect(validateToolsCallArguments(Number.NaN).ok).toBe(false);
    expect(validateToolsCallArguments({ n: Number.NaN }).ok).toBe(false);
    expect(validateToolsCallArguments({ n: Number.POSITIVE_INFINITY }).ok).toBe(false);
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let level = 0; level < 34; level += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    expect(validateToolsCallArguments(deep).ok).toBe(false);
    expect(parseBridgeMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: MAX_FRAME_WIDTH_PX, height: 700 },
    }).ok).toBe(true);
    expect(parseBridgeMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: MAX_FRAME_WIDTH_PX + 1 },
    }).ok).toBe(false);
    expect(parseBridgeMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: "abc" },
    }).ok).toBe(false);
  });

  it("imports in a browser without Node builtins", () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/artifacts/bridge/protocol.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toMatch(/\bprocess\b/);
    expect(source).not.toMatch(/\brequire\b/);
  });
});
