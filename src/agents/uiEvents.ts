import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import type { AgentDefinition } from "../config/loadAgent.js";
import { argsFailure } from "../artifacts/bindings.js";
import { bindingQueryHttpStatus, viewerArgsIssue, type BindingQueryRequest, type BindingQueryResult } from "../artifacts/bindingQuery.js";
import { artifactStorageKey, parseOwnerKey } from "../artifacts/keys.js";
import { ArtifactPublishError } from "../artifacts/limits.js";
import { loadStoredLiveBindings } from "../artifacts/htmlManifest.js";
import { parseStoredLiveManifest, type LiveBinding, type LiveUiAction } from "../artifacts/manifest.js";
import { ArtifactQueryError, readArtifact } from "../artifacts/query.js";
import { readArtifactVersionRow } from "../artifacts/versions.js";
import { loadPinnedFunction } from "../artifacts/refresh.js";
import type { AgentChatController } from "./chatTurn.js";
import { AgentError, type AgentErrorCode } from "./errors.js";
import { isEvalSession } from "./evalSession.js";
import { isToolGranted } from "./policy.js";
import type { AgentService } from "./service.js";
import type Database from "better-sqlite3";

const EVENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
const CACHE_MAX = 5000;

export type ChatArtifact = {
  storageKey: string;
  projectRoot: string;
  projectId: string;
  version: number;
  bindings: LiveBinding[];
  actions: LiveUiAction[];
};

export type UiEventBody = {
  id?: unknown;
  key?: unknown;
  version?: unknown;
  kind?: unknown;
  action?: unknown;
  args?: unknown;
};

export type UiEventResult = {
  status: number;
  body: Record<string, unknown>;
};

export type UiEventHandler = (input: {
  projectRoot: string;
  agentId: string;
  sessionId: string;
  body: UiEventBody;
}) => Promise<UiEventResult>;

const cache = new Map<string, Promise<UiEventResult>>();

export function resetUiEventsForTests(): void {
  cache.clear();
}

function remember(key: string, promise: Promise<UiEventResult>): Promise<UiEventResult> {
  cache.set(key, promise);
  if (cache.size <= CACHE_MAX) return promise;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined && oldest !== key) cache.delete(oldest);
  return promise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function argsOf(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const issue = viewerArgsIssue(value);
  if (issue) {
    throw new AgentError("agent.ui_args_invalid", "Arguments are not valid", [
      { path: issue.path, code: "agent.ui_args_invalid", message: issue.message },
    ]);
  }
  return value as Record<string, unknown>;
}

function fillString(template: string, args: Record<string, unknown>, path: string): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(args, name)) {
      throw new AgentError("agent.ui_args_invalid", "Arguments are not valid", [
        { path, code: "agent.ui_args_invalid", message: `${name} is required` },
      ]);
    }
    const value = args[name];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    throw new AgentError("agent.ui_args_invalid", "Arguments are not valid", [
      { path: `${path}.${name}`, code: "agent.ui_args_invalid", message: "must be a string, number, or boolean" },
    ]);
  });
}

function fillValue(value: unknown, args: Record<string, unknown>, path: string, depth: number): unknown {
  if (depth > 8) {
    throw new AgentError("agent.ui_args_invalid", "Arguments are not valid", [
      { path, code: "agent.ui_args_invalid", message: "is too deep" },
    ]);
  }
  if (typeof value === "string") return fillString(value, args, path);
  if (Array.isArray(value)) return value.map((item, index) => fillValue(item, args, `${path}[${index}]`, depth + 1));
  if (!isRecord(value)) return value;
  const filled: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) filled[key] = fillValue(child, args, `${path}.${key}`, depth + 1);
  return filled;
}

function placeholders(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) placeholders(item, found);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) placeholders(child, found);
}

function assertKnownArgs(args: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new AgentError("agent.ui_args_invalid", "Arguments are not valid", [
        { path: `args.${key}`, code: "agent.ui_args_invalid", message: "is not used by this action" },
      ]);
    }
  }
}

function publishToAgent(error: ArtifactPublishError, code: AgentErrorCode = "agent.ui_args_invalid"): never {
  throw new AgentError(
    code,
    error.message,
    (error.issues ?? []).map((issue) => ({ path: issue.path, code, message: issue.message })),
  );
}

export function createUiEventHandler(deps: {
  service: AgentService;
  chat: AgentChatController;
  loadArtifact: (projectRoot: string, key: string, version: number | undefined) => Promise<ChatArtifact>;
  query: (artifact: ChatArtifact, request: BindingQueryRequest) => Promise<BindingQueryResult>;
  validateArgs?: (projectRoot: string, functionId: string, args: Record<string, unknown>) => Promise<void>;
}): UiEventHandler {
  return async function handleUiEvent(input) {
    const id = input.body.id;
    if (typeof id !== "string" || !EVENT_ID.test(id)) throw new AgentError("agent.invalid", "id is required");
    const cacheKey = `${input.sessionId}\0${id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      const prior = await cached;
      return { status: prior.status, body: { ...prior.body, duplicate: true } };
    }
    const promise = remember(cacheKey, runUiEvent(deps, input, id));
    return promise;
  };
}

async function runUiEvent(
  deps: Parameters<typeof createUiEventHandler>[0],
  input: Parameters<UiEventHandler>[0],
  id: string,
): Promise<UiEventResult> {
  const detail = await deps.service.getSession(input.projectRoot, input.sessionId);
  if (detail.session.agentId !== input.agentId) throw new AgentError("agent.session_not_found");
  if (isEvalSession(detail.session)) throw new AgentError("agent.session_eval_readonly", "Eval sessions are read only");
  const definition = await deps.service.definitionAt(input.projectRoot, input.agentId, detail.session.revision);
  const kind = input.body.kind;
  if (kind !== "query" && kind !== "message" && kind !== "tool") throw new AgentError("agent.invalid", "kind must be query, message, or tool");
  const key = input.body.key;
  if (typeof key !== "string" || key.trim().length === 0) throw new AgentError("agent.invalid", "key is required");
  const actionId = input.body.action;
  if (typeof actionId !== "string" || actionId.trim().length === 0) throw new AgentError("agent.invalid", "action is required");
  let version: number | undefined;
  if (input.body.version !== undefined) {
    if (typeof input.body.version !== "number" || !Number.isInteger(input.body.version) || input.body.version < 1) {
      throw new AgentError("agent.invalid", "version must be a positive integer");
    }
    version = input.body.version;
  }
  const args = argsOf(input.body.args);
  const artifact = await deps.loadArtifact(input.projectRoot, key.trim(), version);
  if (version !== undefined && artifact.version !== version) {
    throw new AgentError("agent.invalid", "Chat actions use the current artifact version");
  }
  if (kind === "query") return queryEvent(deps, input.projectRoot, definition, artifact, id, actionId, args);
  const action = artifact.actions.find((item) => item.id === actionId);
  if (!action || action.type !== kind) throw new AgentError("agent.ui_action_unknown", "That action is not declared");
  const filled = await fillAction(deps, input.projectRoot, artifact, action, args);
  if (kind === "message") {
    const session = await deps.chat.send({
      projectRoot: input.projectRoot,
      agentId: input.agentId,
      sessionId: input.sessionId,
      text: filled.text,
      source: "console",
    });
    return { status: 200, body: eventBody(id, "message", { text: filled.text, session }) };
  }
  if (!action.tool || !isToolGranted(definition, action.tool)) throw new AgentError("agent.tool_not_granted");
  const session = await deps.chat.send({
    projectRoot: input.projectRoot,
    agentId: input.agentId,
    sessionId: input.sessionId,
    text: filled.text,
    source: "console",
    requestedTool: { id: `ui_${id}`, tool: action.tool, input: filled.input },
  });
  return { status: 200, body: eventBody(id, "tool", { text: filled.text, session }) };
}

async function queryEvent(
  deps: Parameters<typeof createUiEventHandler>[0],
  projectRoot: string,
  definition: AgentDefinition,
  artifact: ChatArtifact,
  id: string,
  bindingId: string,
  args: Record<string, unknown> | undefined,
): Promise<UiEventResult> {
  const binding = artifact.bindings.find((item) => item.id === bindingId);
  if (!binding) throw new AgentError("agent.ui_action_unknown", "That binding is not declared");
  if (!definition.ui.functions.includes(binding.function)) {
    throw new AgentError("agent.ui_function_not_granted", `${binding.function} is not granted for chat`);
  }
  const merged = { ...binding.args, ...args };
  if (deps.validateArgs) await deps.validateArgs(projectRoot, binding.function, merged);
  let result: BindingQueryResult;
  try {
    result = await deps.query(artifact, {
      bindingId,
      ...(args ? { args } : {}),
      ifStale: true,
    });
  } catch (error) {
    if (error instanceof ArtifactPublishError) publishToAgent(error);
    throw error;
  }
  return {
    status: bindingQueryHttpStatus(result),
    body: eventBody(id, "query", result),
  };
}

async function fillAction(
  deps: Parameters<typeof createUiEventHandler>[0],
  projectRoot: string,
  artifact: ChatArtifact,
  action: LiveUiAction,
  args: Record<string, unknown> | undefined,
): Promise<{ text: string; input: Record<string, unknown> }> {
  const viewer = args ?? {};
  let values = viewer;
  if (action.binding) {
    const binding = artifact.bindings.find((item) => item.id === action.binding);
    if (!binding) throw new AgentError("agent.ui_action_unknown", "That binding is not declared");
    values = { ...binding.args, ...viewer };
    if (deps.validateArgs) await deps.validateArgs(projectRoot, binding.function, values);
  } else {
    const allowed = new Set<string>();
    placeholders(action.template, allowed);
    placeholders(action.input ?? {}, allowed);
    assertKnownArgs(viewer, allowed);
    values = viewer;
  }
  const text = fillString(action.template, values, "template");
  if (text.length > 8000) throw new AgentError("agent.invalid", "The message is too long");
  const input = fillValue(action.input ?? {}, values, "input", 0);
  if (!isRecord(input)) throw new AgentError("agent.ui_args_invalid", "Arguments are not valid");
  return { text, input };
}

function eventBody(id: string, kind: string, rest: Record<string, unknown>): Record<string, unknown> {
  return { id, duplicate: false, kind, ...rest };
}

export async function loadChatArtifact(
  db: Database.Database,
  roots: readonly CatalogRoot[],
  projectRoot: string,
  key: string,
): Promise<ChatArtifact> {
  const slash = key.lastIndexOf("/");
  if (slash <= 0 || slash === key.length - 1) throw new AgentError("agent.invalid", "key is not an artifact key");
  const ownerKey = key.slice(0, slash);
  const id = key.slice(slash + 1);
  if (!parseOwnerKey(ownerKey)) throw new AgentError("agent.invalid", "key is not an artifact key");
  let record;
  try {
    record = readArtifact(db, ownerKey, id, projectRoot, roots);
  } catch (error) {
    if (error instanceof ArtifactQueryError) {
      throw new AgentError(error.status === 404 ? "agent.ui_artifact_not_found" : "agent.invalid", error.message);
    }
    throw error;
  }
  if (record.status !== "available") throw new AgentError("agent.ui_artifact_not_found", "Artifact is not available");
  const storageKey = artifactStorageKey(record.project.id, ownerKey, record.id);
  const row = readArtifactVersionRow(db, storageKey, record.version);
  const declarative = parseStoredLiveManifest(row?.manifest_json);
  const bindings = declarative?.bindings ?? loadStoredLiveBindings(row?.manifest_json)?.bindings;
  if (!bindings) throw new AgentError("agent.invalid", "Artifact is not live");
  const root = roots.find((item) => item.project_root === record.project.id);
  return {
    storageKey,
    projectRoot: root?.path ?? projectRoot,
    projectId: record.project.id,
    version: record.version,
    bindings,
    actions: declarative?.actions ?? [],
  };
}

export async function validateChatBindingArgs(
  db: Database.Database,
  projectRoot: string,
  functionId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const pinned = await loadPinnedFunction(db, projectRoot, functionId);
  if (!pinned) return;
  const failure = argsFailure(pinned.definition, args, "args");
  if (!failure) return;
  throw new AgentError(
    "agent.ui_args_invalid",
    failure.message,
    failure.issues.map((issue) => ({ path: issue.path, code: "agent.ui_args_invalid", message: issue.message })),
  );
}
