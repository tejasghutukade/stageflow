import { relativizeLocalPathForNetwork } from "../config/catalogRelativePath.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import {
  ensureGlobalService,
  hostBaseUrl,
  type EnsureGlobalServiceResult,
} from "../server/ensureGlobalService.js";
import { httpEnsureProject } from "./hostClient.js";

export const RUN_STAGE_USAGE = `Usage:
  sf run-stage (--stage <path> | --stage-inline '<json>') (--task <path> | --task-inline '<json>' | --envelope-ref <runId>:<stageId>[:<attempt>] [--envelope-ref ...]) [--checkout <path>] [--model <id>] [--blocking] [--timeout-ms <n>] [--json]

Run a single stage directly against the shared Stageflow service, without authoring a pipeline file. Distinct from the internal-only, worker-process-only \`sf internal run-stage\`.
  --stage <path>          Filesystem path to a catalog stage YAML file
  --stage-inline <json>   Inline stage body object ({ id, system_prompt, io, ... } — no uses:/route/pipeline wrapper)
  --task <path>           Filesystem path to a catalog task YAML file
  --task-inline <json>    Inline task object ({ id, goal, ... })
  --envelope-ref <ref>    Resolve a previously stored StageEnvelope as this stage's input instead of a task: <runId>:<stageId>[:<attempt>]. Repeat to pass more than one — each resolved payload is namespaced under its stageId in input (disambiguated by runId on a stageId collision), and summaries are combined into goal.
  --checkout <path>       Optional checkout to use with --envelope-ref (--task/--task-inline carry their own checkout)
  --model <id>            Override the model/backend for this call only, ahead of the stage's own declared model
  --blocking              Wait for the run to reach a terminal or waiting state and print the result in this same call, instead of returning immediately with just the run id
  --timeout-ms <n>        Wait budget in ms when --blocking is set
  --json                  Machine-readable JSON output`;

export type RunStageEnvelopeRef = {
  runId: string;
  stageId: string;
  attempt?: number;
};

export type RunStageToolArgs = {
  stage: string | Record<string, unknown>;
  project_root?: string;
  task_path?: string;
  task?: Record<string, unknown>;
  envelope_ref?: RunStageEnvelopeRef | RunStageEnvelopeRef[];
  checkout?: string;
  model?: string;
  blocking?: boolean;
  timeout_ms?: number;
};

export type RunStageToolResult = {
  isError: boolean;
  payload: Record<string, unknown> | null;
};

export type RunStageCallFn = (
  args: RunStageToolArgs,
) => Promise<RunStageToolResult>;

export type RunStageCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: RunStageCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedRunStageArgs = {
  help: boolean;
  json: boolean;
  blocking: boolean;
  stage?: string;
  stageInline?: string;
  task?: string;
  taskInline?: string;
  envelopeRef?: string[];
  checkout?: string;
  model?: string;
  timeoutMs?: number;
};

function parseRunStageCliArgs(args: string[]): ParsedRunStageArgs {
  if (args.length === 0) {
    return { help: false, json: false, blocking: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false, blocking: false };
  }

  let stage: string | undefined;
  let stageInline: string | undefined;
  let task: string | undefined;
  let taskInline: string | undefined;
  let envelopeRef: string[] | undefined;
  let checkout: string | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;
  let json = false;
  let blocking = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--stage") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --stage");
      }
      stage = value;
    } else if (arg === "--stage-inline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --stage-inline");
      }
      stageInline = value;
    } else if (arg === "--task") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --task");
      }
      task = value;
    } else if (arg === "--task-inline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --task-inline");
      }
      taskInline = value;
    } else if (arg === "--envelope-ref") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --envelope-ref");
      }
      envelopeRef = [...(envelopeRef ?? []), value];
    } else if (arg === "--checkout") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --checkout");
      }
      checkout = value;
    } else if (arg === "--model") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --model");
      }
      model = value;
    } else if (arg === "--timeout-ms") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --timeout-ms");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout-ms: ${value}`);
      }
      timeoutMs = parsed;
    } else if (arg === "--blocking") {
      blocking = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help,
    json,
    blocking,
    stage,
    stageInline,
    task,
    taskInline,
    envelopeRef,
    checkout,
    model,
    timeoutMs,
  };
}

function parseEnvelopeRefFlag(raw: string): RunStageEnvelopeRef {
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      "--envelope-ref must be <runId>:<stageId>[:<attempt>]",
    );
  }
  const [runId, stageId, attemptRaw] = parts;
  if (!runId || !stageId) {
    throw new Error(
      "--envelope-ref must be <runId>:<stageId>[:<attempt>]",
    );
  }
  const ref: RunStageEnvelopeRef = { runId, stageId };
  if (attemptRaw !== undefined) {
    const attempt = Number.parseInt(attemptRaw, 10);
    if (!Number.isFinite(attempt) || attempt < 1) {
      throw new Error("--envelope-ref attempt must be a positive integer");
    }
    ref.attempt = attempt;
  }
  return ref;
}

function parseJsonFlag(raw: string, flagName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${flagName} must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Streamable HTTP MCP is stateful by default (see docs/mcp.md): a bare
 * tools/call POST with no session id is rejected with "Session ID
 * required". Do the same initialize -> notifications/initialized ->
 * tools/call handshake a real MCP client would, against the shared global
 * service (started/ensured by the caller), then close the session.
 */
async function mcpInitializeSession(base: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "sf-cli", version: PACKAGE_VERSION },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  await res.text().catch(() => undefined);
  if (!sessionId) {
    throw new Error(
      `Failed to initialize MCP session against ${base}/mcp (status ${res.status})`,
    );
  }
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  }).catch(() => undefined);
  return sessionId;
}

async function mcpCloseSession(base: string, sessionId: string): Promise<void> {
  await fetch(`${base}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  }).catch(() => undefined);
}

async function mcpToolCall(
  base: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<RunStageToolResult> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(
      `Unexpected MCP response from ${base}/mcp (status ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (message.error) {
    throw new Error(message.error.message ?? "MCP tool call failed");
  }
  const contentText = message.result?.content?.[0]?.text ?? "";
  return {
    isError: Boolean(message.result?.isError),
    payload: contentText ? (JSON.parse(contentText) as Record<string, unknown>) : null,
  };
}

function defaultCallTool(
  base: string,
  ensureService: () => Promise<EnsureGlobalServiceResult>,
): RunStageCallFn {
  return async (args) => {
    const ensured = await ensureService();
    if (!ensured.ok) {
      throw new Error(ensured.message);
    }
    let toolArgs: RunStageToolArgs = args;
    if (args.project_root !== undefined) {
      const ensuredProject = await httpEnsureProject(base, args.project_root);
      if (!ensuredProject.ok) {
        throw new Error(ensuredProject.reason);
      }
      toolArgs = { ...args, project_root: ensuredProject.project_root };
    }
    const sessionId = await mcpInitializeSession(base);
    try {
      return await mcpToolCall(
        base,
        sessionId,
        "run_stage",
        toolArgs as unknown as Record<string, unknown>,
      );
    } finally {
      await mcpCloseSession(base, sessionId);
    }
  };
}

function reportRunStageResult(
  result: RunStageToolResult,
  options: { json: boolean; io: RunStageCommandIo },
): number {
  const { io, json } = options;
  const payload = result.payload ?? {};

  if (result.isError) {
    if (json) {
      io.log(JSON.stringify(payload, null, 2));
    } else {
      const message =
        typeof payload.error === "string" ? payload.error : "run_stage failed";
      io.error(message);
    }
    return 1;
  }

  const status = payload.status as string | undefined;

  if (status === undefined) {
    // Async mode: { runId, stageId }.
    if (json) {
      io.log(JSON.stringify(payload, null, 2));
    } else {
      io.log(`Stage run started: ${payload.runId} (stage: ${payload.stageId})`);
    }
    return 0;
  }

  // Blocking mode: { runId, stageId, status, envelope? | pending_prompt? }.
  if (json) {
    io.log(JSON.stringify(payload, null, 2));
  } else if (status === "completed") {
    const envelope = payload.envelope as
      | { status?: string; summary?: string }
      | null
      | undefined;
    if (envelope?.status === "failure") {
      io.error(`Stage failed: ${envelope.summary ?? ""}`);
    } else {
      io.log(`Stage completed: ${envelope?.summary ?? ""}`);
    }
  } else if (status === "needs_input") {
    io.error(
      `Stage waiting for input (run ${payload.runId}, stage ${payload.stageId}).`,
    );
  } else if (status === "timeout") {
    io.error(`Timed out waiting for stage to finish (run ${payload.runId}).`);
  }

  if (status === "completed") {
    const envelope = payload.envelope as { status?: string } | null | undefined;
    return envelope?.status === "failure" ? 1 : 0;
  }
  if (status === "needs_input" || status === "timeout") {
    return 2;
  }
  return 0;
}

export async function runRunStageCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<RunStageCommandIo>;
    callTool?: RunStageCallFn;
    hostBaseUrl?: string;
    ensureService?: () => Promise<EnsureGlobalServiceResult>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: RunStageCommandIo = { ...defaultIo, ...options.io };
  const base = options.hostBaseUrl ?? hostBaseUrl();

  let parsed: ParsedRunStageArgs;
  try {
    parsed = parseRunStageCliArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(RUN_STAGE_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(RUN_STAGE_USAGE);
    return 0;
  }

  if (Boolean(parsed.stage) === Boolean(parsed.stageInline)) {
    out.error("Exactly one of --stage or --stage-inline is required");
    out.error(RUN_STAGE_USAGE);
    return 1;
  }

  const inputFlagCount = [parsed.task, parsed.taskInline, parsed.envelopeRef].filter(
    (v) => v !== undefined,
  ).length;
  if (inputFlagCount !== 1) {
    out.error(
      "Exactly one of --task, --task-inline, or --envelope-ref is required",
    );
    out.error(RUN_STAGE_USAGE);
    return 1;
  }

  let stage: string | Record<string, unknown>;
  let projectRoot: string | undefined;
  try {
    if (parsed.stage !== undefined) {
      const stageRef = relativizeLocalPathForNetwork(cwd, parsed.stage);
      stage = stageRef.path;
      projectRoot = stageRef.project_root;
    } else {
      stage = parseJsonFlag(parsed.stageInline!, "--stage-inline");
    }
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let taskPath: string | undefined;
  let task: Record<string, unknown> | undefined;
  let envelopeRef: RunStageEnvelopeRef | RunStageEnvelopeRef[] | undefined;
  try {
    if (parsed.task !== undefined) {
      const taskRef = relativizeLocalPathForNetwork(cwd, parsed.task);
      taskPath = taskRef.path;
      projectRoot = taskRef.project_root;
    } else if (parsed.taskInline !== undefined) {
      task = parseJsonFlag(parsed.taskInline, "--task-inline");
    } else {
      const refs = parsed.envelopeRef!.map(parseEnvelopeRefFlag);
      envelopeRef = refs.length === 1 ? refs[0] : refs;
    }
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let checkout: string | undefined;
  if (parsed.checkout !== undefined) {
    try {
      const checkoutRef = relativizeLocalPathForNetwork(cwd, parsed.checkout);
      checkout = checkoutRef.path;
      projectRoot = projectRoot ?? checkoutRef.project_root;
    } catch (err) {
      out.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const toolArgs: RunStageToolArgs = {
    stage,
    ...(projectRoot !== undefined ? { project_root: projectRoot } : {}),
    ...(taskPath !== undefined ? { task_path: taskPath } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(envelopeRef !== undefined ? { envelope_ref: envelopeRef } : {}),
    ...(checkout !== undefined ? { checkout } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.blocking ? { blocking: true } : {}),
    ...(parsed.timeoutMs !== undefined ? { timeout_ms: parsed.timeoutMs } : {}),
  };

  const callTool =
    options.callTool ??
    defaultCallTool(base, options.ensureService ?? (() => ensureGlobalService()));

  let result: RunStageToolResult;
  try {
    result = await callTool(toolArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      out.log(JSON.stringify({ error: message }));
    } else {
      out.error(message);
    }
    return 1;
  }

  return reportRunStageResult(result, { json: parsed.json, io: out });
}
