import type Database from "better-sqlite3";
import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";
import {
  functionSourceHash,
  readFunctionFile,
  type FunctionDefinition,
  type FunctionGrant,
} from "../config/loadFunction.js";
import { effectiveFunctionPolicy } from "./toolPolicy.js";
import { canonicalJson } from "../evals/canonical.js";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  createFunctionInvoker,
  hostFunctionInvoker,
  type FunctionCallInput,
  type FunctionInvoker,
  type FunctionRunView,
} from "./invoke.js";
import { FunctionService } from "./service.js";
import { FunctionStore } from "./store.js";

export type FunctionToolInvoker = {
  call(projectRoot: string, input: FunctionCallInput): Promise<FunctionRunView>;
};

export type FunctionToolResult =
  | { ok: true; text: string }
  | { ok: false; text: string; code: string };

export type FunctionToolExecution = {
  project?: string;
  run?: string;
  stage?: string;
  attempt?: number;
  agent?: string;
  session?: string;
  toolCall?: string;
};

export type FunctionSnapshotPin = {
  id: string;
  source_hash: string;
  policy: string;
};

export type ResolvedFunctionTool = {
  functionId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  grants: FunctionGrant[];
  run: (args: unknown, callId: string) => Promise<FunctionToolResult>;
};

export function claudeFunctionToolReason(toolName: string): string {
  return `stage attaches function tool "${toolName}"; the model would see it as mcp__stageflow__${toolName} instead of ${toolName}`;
}

export function cursorFunctionToolReason(toolName: string): string {
  return `stage attaches function tool "${toolName}"; the model would see it as pi__${toolName} instead of ${toolName}`;
}

export async function functionSnapshotPins(
  projectRoot: string,
  attachments: ReadonlyArray<{ id: string; grants: FunctionGrant[] }>,
): Promise<FunctionSnapshotPin[]> {
  const pins: FunctionSnapshotPin[] = [];
  for (const attachment of attachments) {
    const file = await readFunctionFile(projectRoot, attachment.id);
    if (file.missing || !file.parsed.ok) {
      pins.push({ id: attachment.id, source_hash: "missing", policy: "missing" });
      continue;
    }
    pins.push({
      id: attachment.id,
      source_hash: functionSourceHash(file.parsed.value.source),
      policy: canonicalJson(effectiveFunctionPolicy(file.parsed.value, attachment.grants)),
    });
  }
  return pins;
}

export async function resolveFunctionTools(input: {
  projectRoot: string;
  attachments: ReadonlyArray<{ id: string; grants: FunctionGrant[] }>;
  db?: Database.Database;
  invoker?: FunctionToolInvoker;
  execution?: (callId: string) => FunctionToolExecution;
}): Promise<{ ok: true; tools: ResolvedFunctionTool[] } | { ok: false; reason: string }> {
  const tools: ResolvedFunctionTool[] = [];
  const names = new Set<string>();
  for (const attachment of input.attachments) {
    const file = await readFunctionFile(input.projectRoot, attachment.id);
    if (file.missing || !file.parsed.ok || file.parsed.value.id !== attachment.id) {
      return { ok: false, reason: `Function "${attachment.id}" is not available` };
    }
    const definition = file.parsed.value;
    if (definition.kind !== "tool" || !definition.tool_name || !definition.tool_description) {
      return { ok: false, reason: `Function "${attachment.id}" is not a tool` };
    }
    if (names.has(definition.tool_name)) {
      return { ok: false, reason: `Function tool "${definition.tool_name}" is already registered` };
    }
    names.add(definition.tool_name);
    const grants = attachment.grants;
    tools.push({
      functionId: definition.id,
      name: definition.tool_name,
      description: definition.tool_description,
      parameters: definition.input_schema ?? { type: "object", properties: {} },
      grants,
      run: (args, callId) =>
        runAttachedFunctionTool({
          projectRoot: input.projectRoot,
          functionId: definition.id,
          grants,
          args,
          db: input.db,
          invoker: input.invoker,
          definition,
          execution: { ...(input.execution?.(callId) ?? {}), toolCall: callId },
        }),
    });
  }
  return { ok: true, tools };
}

export async function runAttachedFunctionTool(input: {
  projectRoot: string;
  functionId: string;
  grants: readonly FunctionGrant[];
  args: unknown;
  revision?: number;
  db?: Database.Database;
  invoker?: FunctionToolInvoker;
  definition?: FunctionDefinition;
  execution?: FunctionToolExecution;
}): Promise<FunctionToolResult> {
  const definition = input.definition ?? (await loadDefinition(input.projectRoot, input.functionId));
  if (!definition) return { ok: false, code: "invalid_input", text: `Function "${input.functionId}" is not available` };
  const invalid = argumentError(definition, input.args);
  if (invalid) return invalid;
  const invoker = input.invoker ?? invokerFor(input.db);
  const revision = input.revision ?? (await pinnedToolRevision(input));
  const view = await invoker.call(input.projectRoot, {
    functionId: input.functionId,
    kind: "tool",
    ...(revision !== undefined ? { revision } : {}),
    grants: input.grants,
    input: toolContext(input.functionId, input.args, input.execution),
    ...(input.execution?.run !== undefined ? { runId: input.execution.run } : {}),
    ...(input.execution?.session !== undefined ? { sessionId: input.execution.session } : {}),
    ...(input.execution?.stage !== undefined ? { stageId: input.execution.stage } : {}),
    ...(input.execution?.attempt !== undefined ? { attempt: input.execution.attempt } : {}),
  });
  if (!view.ok || view.code === "uncertain_outcome" || view.status === "uncertain") {
    const code = view.code ?? "exception";
    const message = view.message ?? "function tool failed";
    const text = code === "uncertain_outcome" || view.status === "uncertain"
      ? `${message} The outcome is uncertain and was not retried.`
      : message;
    return { ok: false, code: code === "uncertain_outcome" || view.status === "uncertain" ? "uncertain_outcome" : code, text };
  }
  if (definition.output_schema) {
    const mismatch = schemaMismatch(view.value, definition.output_schema);
    if (mismatch) return { ok: false, code: "invalid_output", text: mismatch };
  }
  return { ok: true, text: JSON.stringify(view.value ?? null) };
}

function toolContext(functionId: string, args: unknown, execution: FunctionToolExecution | undefined): Record<string, unknown> {
  const identity: Record<string, unknown> = { functionId };
  for (const [key, value] of Object.entries(execution ?? {})) {
    if (value !== undefined) identity[key] = value;
  }
  return { kind: "tool", input: args, envelope: null, execution: identity };
}

function argumentError(definition: FunctionDefinition, args: unknown): FunctionToolResult | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, code: "invalid_input", text: "Tool arguments must be an object" };
  }
  if (!definition.input_schema) return undefined;
  const mismatch = schemaMismatch(args, definition.input_schema);
  if (!mismatch) return undefined;
  return { ok: false, code: "invalid_input", text: mismatch };
}

function schemaMismatch(value: unknown, schema: Record<string, unknown>): string | undefined {
  try {
    return payloadInstanceMismatch(value, schema);
  } catch (error) {
    return error instanceof Error ? error.message : "schema rejected the value";
  }
}

async function loadDefinition(projectRoot: string, functionId: string): Promise<FunctionDefinition | undefined> {
  const file = await readFunctionFile(projectRoot, functionId);
  if (file.missing || !file.parsed.ok || file.parsed.value.id !== functionId) return undefined;
  return file.parsed.value;
}

function invokerFor(db: Database.Database | undefined): FunctionInvoker {
  if (db) return createFunctionInvoker({ db, stageflowHome: globalStageflowHome() });
  return hostFunctionInvoker();
}

async function pinnedToolRevision(input: {
  projectRoot: string;
  functionId: string;
  db?: Database.Database;
  execution?: FunctionToolExecution;
}): Promise<number | undefined> {
  if (!input.db) return undefined;
  const service = new FunctionService({ store: new FunctionStore(input.db) });
  if (input.execution?.run) {
    const pin = await service.getPin(input.projectRoot, "run", input.execution.run, input.functionId);
    return pin?.revision;
  }
  if (input.execution?.session) {
    const pin = await service.getPin(input.projectRoot, "session", input.execution.session, input.functionId);
    return pin?.revision;
  }
  return undefined;
}
