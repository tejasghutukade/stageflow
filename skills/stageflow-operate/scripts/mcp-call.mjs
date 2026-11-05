#!/usr/bin/env node

import { readFileSync } from "node:fs";

function defaultBaseUrl(env = process.env) {
  const raw = Number(env.STAGEFLOW_SERVICE_PORT);
  const port = Number.isFinite(raw) && raw > 0 ? raw : 3847;
  return `http://127.0.0.1:${port}`;
}

const DEFAULT_BASE_URL = defaultBaseUrl();
const ALLOWED_TOOLS = new Set([
  "abandon_stage",
  "accept_eval_failure_suggestions",
  "agent_chat",
  "answer_gate",
  "approve_agent_action",
  "archive_agent",
  "calibrate_eval_grader",
  "cancel_eval_run",
  "cancel_run",
  "compare_eval_runs",
  "convert_dataset",
  "create_agent",
  "create_connection",
  "create_dataset",
  "create_eval",
  "create_memory",
  "create_pipeline",
  "create_stage",
  "create_stage_file",
  "create_task",
  "create_task_file",
  "create_trigger",
  "decide_feedback_loop",
  "delete_eval_run",
  "delete_memory_card",
  "delete_run",
  "deny_agent_action",
  "describe_pipeline",
  "diff_agent_revisions",
  "disable_agent",
  "dismiss_eval_failure_suggestions",
  "edit_pipeline",
  "edit_stage",
  "edit_task",
  "enable_agent",
  "export_run",
  "fire_trigger",
  "gc_runs",
  "get_agent",
  "get_agent_revision",
  "get_agent_session",
  "get_envelope",
  "get_eval",
  "get_eval_failure_sort_status",
  "get_eval_failure_suggestions",
  "get_eval_result",
  "get_eval_results",
  "get_eval_run",
  "get_eval_run_export",
  "get_health",
  "get_memory",
  "get_run",
  "get_run_diff",
  "get_stage_verification",
  "get_started",
  "get_trigger",
  "get_waiting_summary",
  "import_task_file",
  "install_eval_sample",
  "list_agent_revisions",
  "list_agent_sessions",
  "list_agents",
  "list_checkout_changes",
  "list_connections",
  "list_eval_runs",
  "list_evals",
  "list_grader_calibrations",
  "list_memories",
  "list_models",
  "list_pipelines",
  "list_project_mcp",
  "list_providers",
  "list_runs",
  "list_skills",
  "list_stage_events",
  "list_tasks",
  "list_triggers",
  "list_waiting",
  "preflight",
  "probe_project_mcp",
  "put_eval_review",
  "read_artifact",
  "read_checkout_file",
  "read_pipeline",
  "recover_manual_stage",
  "remove_connection",
  "rerun",
  "restore_agent_revision",
  "resume_stage",
  "retry_stage",
  "run_eval",
  "run_stage",
  "save_agent",
  "set_trigger_enabled",
  "sort_eval_failures",
  "start_run",
  "stop_agent_session",
  "stop_manual_recovery",
  "tail_stage_log",
  "test_connection",
  "try_eval_case",
  "update_connection",
  "update_dataset_cases",
  "update_eval",
  "update_task_file",
  "update_trigger",
  "validate",
  "validate_agent",
  "validate_catalog_draft",
  "validate_connection_target",
  "validate_eval",
  "wait_run",
  "write_catalog_file",
  "write_memory",
  "write_memory_card",
]);
const PROTOCOL_VERSION = "2025-03-26";
const INIT_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const WAIT_RUN_DEFAULT_MS = 60_000;
const WAIT_RUN_BUFFER_MS = 5_000;
const WAIT_RUN_CAP_MS = 250_000;
const LONG_CALL_TOOLS = new Set(["agent_chat"]);
const LONG_CALL_MS = 250_000;
const PROBE_TIMEOUT_MS = 1_500;

function controlTokenFromEnv(env = process.env) {
  const plain = env.STAGEFLOW_CONTROL_TOKEN;
  const filePath = env.STAGEFLOW_CONTROL_TOKEN_FILE;
  const hasPlain = plain !== undefined && plain.length > 0;
  const hasFile = filePath !== undefined && filePath.length > 0;
  if (hasPlain && hasFile) {
    console.error("mcp-call: set only one of STAGEFLOW_CONTROL_TOKEN or STAGEFLOW_CONTROL_TOKEN_FILE");
    process.exit(2);
  }
  if (hasFile) {
    try {
      return readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
    } catch (err) {
      console.error(
        `mcp-call: failed to read STAGEFLOW_CONTROL_TOKEN_FILE=${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(2);
    }
  }
  if (hasPlain) return plain;
  return undefined;
}

function authHeaders(token) {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function usage() {
  return "Usage: mcp-call.mjs [--base-url URL] --tool NAME [--args JSON] [--stateless] [--timeout-ms N]\n       mcp-call.mjs [--base-url URL] --probe\n       mcp-call.mjs [--base-url URL] --list-tools [--stateless]";
}

function parseArgs(argv) {
  let baseUrl = DEFAULT_BASE_URL;
  let tool;
  let argsText = "{}";
  let stateless = false;
  let probe = false;
  let listTools = false;
  let timeoutMs;
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
    if (arg === "--probe") {
      probe = true;
      continue;
    }
    if (arg === "--list-tools") {
      listTools = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        console.error("mcp-call: --timeout-ms requires a positive number");
        console.error(usage());
        process.exit(2);
      }
      timeoutMs = value;
      i += 1;
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
  return { baseUrl, tool, argsText, stateless, probe, listTools, timeoutMs };
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

function toolTimeoutMs(tool, toolArgs, override) {
  if (override !== undefined) return override;
  if (LONG_CALL_TOOLS.has(tool)) return LONG_CALL_MS;
  const waits =
    tool === "wait_run" ||
    (tool === "run_stage" && toolArgs.blocking === true) ||
    (tool === "run_eval" && toolArgs.wait === true);
  if (!waits) return DEFAULT_TOOL_TIMEOUT_MS;
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

async function postMcp(mcpUrl, { body, sessionId, timeoutMs, token }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders(token),
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

async function initializeSession(mcpUrl, token) {
  const { res, text } = await postMcp(mcpUrl, {
    body: {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stageflow-operate", version: "1.0.0" },
      },
    },
    timeoutMs: INIT_TIMEOUT_MS,
    token,
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
      token,
    });
  } catch {}
  return sessionId;
}

async function closeSession(mcpUrl, sessionId, token) {
  if (!sessionId) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INIT_TIMEOUT_MS);
  try {
    await fetch(mcpUrl, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId, ...authHeaders(token) },
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

async function probeHost(baseUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  let up = false;
  try {
    const res = await fetch(`${baseUrl}/livez`, { signal: ac.signal });
    if (res.status === 200) {
      JSON.parse(await res.text());
      up = true;
    }
  } catch {
    up = false;
  } finally {
    clearTimeout(timer);
  }
  const bearer = controlTokenFromEnv() !== undefined ? " bearer" : "";
  console.log(`${up ? "up" : "down"} ${baseUrl}${bearer}`);
  return up ? 0 : 1;
}

async function listRemoteTools(baseUrl, stateless) {
  const mcpUrl = `${baseUrl}/mcp`;
  const token = controlTokenFromEnv();
  let sessionId;
  try {
    if (!stateless) sessionId = await initializeSession(mcpUrl, token);
    const { res, text } = await postMcp(mcpUrl, {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      sessionId,
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      token,
    });
    const message = parseMcpMessage(text);
    const tools = message?.result?.tools;
    if (res.status < 200 || res.status >= 300 || !Array.isArray(tools)) {
      failTransport(`tools/list failed (${res.status})`, message?.error ?? { status: res.status, body: text });
      return 1;
    }
    const names = tools.map((item) => item.name).sort();
    process.stdout.write(`${JSON.stringify({ tools: names, unknown_to_script: names.filter((n) => !ALLOWED_TOOLS.has(n)) })}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof Error && err.message === "initialize failed")) {
      failTransport(err instanceof Error ? err.message : String(err));
    }
    return 1;
  } finally {
    if (sessionId) await closeSession(mcpUrl, sessionId, token);
  }
}

const { baseUrl, tool, argsText, stateless, probe, listTools, timeoutMs: timeoutOverride } = parseArgs(
  process.argv.slice(2),
);

if (probe) {
  process.exit(await probeHost(baseUrl));
}

if (listTools) {
  process.exit(await listRemoteTools(baseUrl, stateless));
}

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
const timeoutMs = toolTimeoutMs(tool, toolArgs, timeoutOverride);
const token = controlTokenFromEnv();

let sessionId;
let exitCode = 1;
try {
  if (!stateless) {
    sessionId = await initializeSession(mcpUrl, token);
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
    token,
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
    await closeSession(mcpUrl, sessionId, token);
  }
}
process.exit(exitCode);
