#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:3847";
const ALLOWED_TOOLS = new Set([
  "list_pipelines",
  "list_tasks",
  "start_run",
  "get_run",
  "wait_run",
  "list_waiting",
  "answer_gate",
  "get_health",
]);
const PROTOCOL_VERSION = "2025-03-26";
const INIT_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const WAIT_RUN_DEFAULT_MS = 60_000;
const WAIT_RUN_BUFFER_MS = 5_000;
const WAIT_RUN_CAP_MS = 250_000;

function usage() {
  return "Usage: mcp-call.mjs --base-url URL --tool NAME --args JSON [--stateless]";
}

function parseArgs(argv) {
  let baseUrl = DEFAULT_BASE_URL;
  let tool;
  let argsText = "{}";
  let stateless = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--stateless") {
      stateless = true;
      continue;
    }
    if (arg === "--base-url") {
      const value = argv[i + 1];
      if (!value) {
        console.error("mcp-call: --base-url requires a URL");
        console.error(usage());
        process.exit(2);
      }
      baseUrl = value.replace(/\/$/, "");
      i += 1;
      continue;
    }
    if (arg === "--tool") {
      const value = argv[i + 1];
      if (!value) {
        console.error("mcp-call: --tool requires a name");
        console.error(usage());
        process.exit(2);
      }
      tool = value;
      i += 1;
      continue;
    }
    if (arg === "--args") {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error("mcp-call: --args requires JSON");
        console.error(usage());
        process.exit(2);
      }
      argsText = value;
      i += 1;
      continue;
    }
    console.error(`mcp-call: unknown argument: ${arg}`);
    console.error(usage());
    process.exit(2);
  }
  return { baseUrl, tool, argsText, stateless };
}

function parseToolArgs(argsText) {
  try {
    const value = JSON.parse(argsText);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      console.error("mcp-call: --args must be a JSON object");
      process.exit(2);
    }
    return value;
  } catch {
    console.error("mcp-call: --args is not valid JSON");
    process.exit(2);
  }
}

function toolTimeoutMs(tool, toolArgs) {
  if (tool !== "wait_run") return DEFAULT_TOOL_TIMEOUT_MS;
  const budget =
    typeof toolArgs.timeout_ms === "number" && toolArgs.timeout_ms > 0
      ? toolArgs.timeout_ms
      : WAIT_RUN_DEFAULT_MS;
  return Math.min(budget + WAIT_RUN_BUFFER_MS, WAIT_RUN_CAP_MS);
}

function parseMcpMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const looksSse =
    /(?:^|\n)(?:event:|data:)/.test(trimmed) || trimmed.startsWith("event:") || trimmed.startsWith("data:");
  if (looksSse) {
    const payloads = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(line.startsWith("data: ") ? 6 : 5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        payloads.push(JSON.parse(raw));
      } catch {}
    }
    return (
      payloads.find((item) => item && (item.result !== undefined || item.error !== undefined)) ??
      payloads.at(-1)
    );
  }
  return JSON.parse(trimmed);
}

function extractToolPayload(message) {
  if (message.error) {
    return { payload: message.error, isError: true };
  }
  const result = message.result;
  if (!result || typeof result !== "object") {
    return { payload: message, isError: true };
  }
  const text = result.content?.[0]?.text;
  let payload;
  if (typeof text === "string" && text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  } else if (result.structuredContent !== undefined) {
    payload = result.structuredContent;
  } else {
    payload = result;
  }
  return { payload, isError: result.isError === true };
}

async function postMcp(mcpUrl, { body, sessionId, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

function failTransport(detail, extra) {
  if (extra !== undefined) {
    process.stdout.write(`${JSON.stringify(extra)}\n`);
  }
  console.error(`mcp-call: ${detail}`);
}

async function initializeSession(mcpUrl) {
  const { res, text } = await postMcp(mcpUrl, {
    body: {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stageflow-run", version: "1.0.0" },
      },
    },
    timeoutMs: INIT_TIMEOUT_MS,
  });
  if (res.status < 200 || res.status >= 300) {
    let extra;
    try {
      extra = parseMcpMessage(text) ?? { status: res.status, body: text };
    } catch {
      extra = { status: res.status, body: text };
    }
    failTransport(`initialize failed (${res.status})`, extra.error ?? extra);
    throw new Error("initialize failed");
  }
  const sessionId = res.headers.get("mcp-session-id") ?? undefined;
  try {
    await postMcp(mcpUrl, {
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
      timeoutMs: INIT_TIMEOUT_MS,
    });
  } catch {}
  return sessionId;
}

async function closeSession(mcpUrl, sessionId) {
  if (!sessionId) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INIT_TIMEOUT_MS);
  try {
    await fetch(mcpUrl, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
      signal: ac.signal,
    });
  } catch {
  } finally {
    clearTimeout(timer);
  }
}

function handleToolResponse(res, text) {
  let message;
  try {
    message = parseMcpMessage(text);
  } catch {
    failTransport(`unreadable response (${res.status})`, { status: res.status, body: text });
    return 1;
  }
  if (res.status < 200 || res.status >= 300) {
    failTransport(`HTTP ${res.status}`, message?.error ?? message ?? { status: res.status, body: text });
    return 1;
  }
  if (!message) {
    failTransport(`empty response (${res.status})`, { status: res.status });
    return 1;
  }
  const { payload, isError } = extractToolPayload(message);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return isError ? 1 : 0;
}

const { baseUrl, tool, argsText, stateless } = parseArgs(process.argv.slice(2));

if (!tool) {
  console.error("mcp-call: --tool is required");
  console.error(usage());
  process.exit(2);
}

if (!ALLOWED_TOOLS.has(tool)) {
  console.error(`mcp-call: unknown tool: ${tool}`);
  console.error(`allowed: ${[...ALLOWED_TOOLS].join(", ")}`);
  process.exit(2);
}

const toolArgs = parseToolArgs(argsText);
const mcpUrl = `${baseUrl}/mcp`;
const timeoutMs = toolTimeoutMs(tool, toolArgs);

let sessionId;
let exitCode = 1;
try {
  if (!stateless) {
    sessionId = await initializeSession(mcpUrl);
  }
  const { res, text } = await postMcp(mcpUrl, {
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: toolArgs },
    },
    sessionId,
    timeoutMs,
  });
  exitCode = handleToolResponse(res, text);
} catch (err) {
  if (err instanceof Error && err.message === "initialize failed") {
    exitCode = 1;
  } else {
    const aborted = err && typeof err === "object" && err.name === "AbortError";
    failTransport(aborted ? "request timed out" : err instanceof Error ? err.message : String(err));
    exitCode = 1;
  }
} finally {
  if (sessionId) {
    await closeSession(mcpUrl, sessionId);
  }
}
process.exit(exitCode);
