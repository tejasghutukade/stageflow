import { createHash } from "node:crypto";
import { canonicalJson } from "../evals/canonical.js";
import { LIVE_DECLARATIVE_KIND } from "./kinds.js";
import {
  LIVE_BINDING_ARGS_MAX_BYTES,
  LIVE_BINDING_ID_PATTERN,
  LIVE_BINDING_MAX,
  LIVE_PROGRAM_MAX_BYTES,
  LIVE_REFRESH_MIN_SECONDS,
  ArtifactPublishError,
  type ArtifactIssue,
} from "./limits.js";

export type LiveBinding = {
  id: string;
  function: string;
  args: Record<string, unknown>;
};

export type LiveRefresh = {
  on_view?: boolean;
  ttl_seconds?: number;
  auto_seconds?: number;
};

export type LiveLibrary = {
  name: string;
  version: string;
};

/** Spec manifest stored with a live.declarative artifact. `program` is opaque text. */
export type LiveBindingSet = {
  bindings: LiveBinding[];
  refresh?: LiveRefresh;
};

/** A chat action the program's manifest allows. The console never invents one. */
export type LiveUiAction = {
  id: string;
  type: "message" | "tool";
  template: string;
  label?: string;
  /** Viewer arguments are checked against this binding's function schema. */
  binding?: string;
  /** Grant id the turn asks the agent to call. Tool actions only. */
  tool?: string;
  /** Arguments of that call. Strings may contain `{{name}}` placeholders. */
  input?: Record<string, unknown>;
};

export type LiveManifest = LiveBindingSet & {
  format: string;
  library: LiveLibrary;
  program: string;
  actions?: LiveUiAction[];
};

const FUNCTION_ID = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION_ID = LIVE_BINDING_ID_PATTERN;
const TOOL_ID = /^(agent:[a-z][a-z0-9_]{0,63}|[A-Za-z0-9_.-]{1,128})$/;
const MAX_LIVE_ACTIONS = 16;
const MAX_ACTION_TEMPLATE_CHARS = 2000;
const MAX_ACTION_LABEL_CHARS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(issues: ArtifactIssue[]): never {
  const message = issues[0]?.message ?? "Live artifact manifest is not valid";
  throw new ArtifactPublishError(400, "artifact.invalid_shape", message, issues);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function collectLiveBindings(bindingsRaw: unknown, issues: ArtifactIssue[]): LiveBinding[] {
  const bindings: LiveBinding[] = [];
  if (!Array.isArray(bindingsRaw)) {
    issues.push({ path: "manifest.bindings", message: "bindings must be an array" });
    return bindings;
  }
  if (bindingsRaw.length > LIVE_BINDING_MAX) {
    issues.push({ path: "manifest.bindings", message: `at most ${LIVE_BINDING_MAX} bindings` });
    return bindings;
  }
  const seen = new Set<string>();
  for (let index = 0; index < bindingsRaw.length; index += 1) {
    const entry = bindingsRaw[index];
    const base = `manifest.bindings[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: base, message: "binding must be an object" });
      continue;
    }
    const id = entry.id;
    if (typeof id !== "string" || !LIVE_BINDING_ID_PATTERN.test(id)) {
      issues.push({ path: `${base}.id`, message: "binding id must match ^[a-z][a-z0-9_]{0,31}$" });
    } else if (seen.has(id)) {
      issues.push({ path: `${base}.id`, message: `binding id ${id} is repeated` });
    } else {
      seen.add(id);
    }
    const functionId = entry.function;
    if (typeof functionId !== "string" || !FUNCTION_ID.test(functionId)) {
      issues.push({ path: `${base}.function`, message: "function must be a function id" });
    }
    const args = entry.args;
    if (!isRecord(args)) {
      issues.push({ path: `${base}.args`, message: "args must be an object" });
    } else if (jsonBytes(args) > LIVE_BINDING_ARGS_MAX_BYTES) {
      issues.push({ path: `${base}.args`, message: `args must be at most ${LIVE_BINDING_ARGS_MAX_BYTES} bytes` });
    }
    if (typeof id === "string" && typeof functionId === "string" && isRecord(args) && issues.every((issue) => !issue.path.startsWith(base))) {
      bindings.push({ id, function: functionId, args });
    }
  }
  return bindings;
}

export function collectLiveActions(actionsRaw: unknown, bindings: readonly { id: string }[], issues: ArtifactIssue[]): LiveUiAction[] {
  if (actionsRaw === undefined) return [];
  if (!Array.isArray(actionsRaw)) {
    issues.push({ path: "manifest.actions", message: "actions must be an array" });
    return [];
  }
  if (actionsRaw.length > MAX_LIVE_ACTIONS) {
    issues.push({ path: "manifest.actions", message: `at most ${MAX_LIVE_ACTIONS} actions` });
    return [];
  }
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  const seen = new Set<string>();
  const actions: LiveUiAction[] = [];
  for (let index = 0; index < actionsRaw.length; index += 1) {
    const entry = actionsRaw[index];
    const base = `manifest.actions[${index}]`;
    const start = issues.length;
    if (!isRecord(entry)) {
      issues.push({ path: base, message: "action must be an object" });
      continue;
    }
    const id = entry.id;
    if (typeof id !== "string" || !ACTION_ID.test(id)) {
      issues.push({ path: `${base}.id`, message: "action id must match ^[a-z][a-z0-9_]{0,31}$" });
    } else if (seen.has(id)) {
      issues.push({ path: `${base}.id`, message: `action id ${id} is repeated` });
    } else {
      seen.add(id);
    }
    const type = entry.type;
    if (type !== "message" && type !== "tool") {
      issues.push({ path: `${base}.type`, message: "type must be message or tool" });
    }
    const template = entry.template;
    if (typeof template !== "string" || template.trim().length === 0 || template.length > MAX_ACTION_TEMPLATE_CHARS) {
      issues.push({ path: `${base}.template`, message: `template must be a string of 1 to ${MAX_ACTION_TEMPLATE_CHARS} characters` });
    }
    let label: string | undefined;
    if (entry.label !== undefined) {
      if (typeof entry.label !== "string" || entry.label.trim().length === 0 || entry.label.length > MAX_ACTION_LABEL_CHARS) {
        issues.push({ path: `${base}.label`, message: `label must be a string of 1 to ${MAX_ACTION_LABEL_CHARS} characters` });
      } else {
        label = entry.label;
      }
    }
    let binding: string | undefined;
    if (entry.binding !== undefined) {
      if (typeof entry.binding !== "string" || !ACTION_ID.test(entry.binding) || !bindingIds.has(entry.binding)) {
        issues.push({ path: `${base}.binding`, message: "binding must name a binding in this manifest" });
      } else {
        binding = entry.binding;
      }
    }
    let tool: string | undefined;
    let input: Record<string, unknown> | undefined;
    if (type === "tool") {
      if (typeof entry.tool !== "string" || !TOOL_ID.test(entry.tool)) {
        issues.push({ path: `${base}.tool`, message: "tool must be a tool id" });
      } else {
        tool = entry.tool;
      }
      if (entry.input !== undefined) {
        if (!isRecord(entry.input)) {
          issues.push({ path: `${base}.input`, message: "input must be an object" });
        } else if (jsonBytes(entry.input) > LIVE_BINDING_ARGS_MAX_BYTES) {
          issues.push({ path: `${base}.input`, message: `input must be at most ${LIVE_BINDING_ARGS_MAX_BYTES} bytes` });
        } else {
          input = entry.input;
        }
      }
    } else if (entry.tool !== undefined || entry.input !== undefined) {
      issues.push({ path: base, message: "message actions do not take tool or input" });
    }
    if (
      issues.length === start &&
      typeof id === "string" &&
      (type === "message" || type === "tool") &&
      typeof template === "string" &&
      (type !== "tool" || typeof tool === "string")
    ) {
      const action: LiveUiAction = { id, type, template };
      if (label !== undefined) action.label = label;
      if (binding !== undefined) action.binding = binding;
      if (tool !== undefined) action.tool = tool;
      if (input !== undefined) action.input = input;
      actions.push(action);
    }
  }
  return actions;
}

export function collectLiveRefresh(refreshRaw: unknown, issues: ArtifactIssue[]): LiveRefresh | undefined {
  if (refreshRaw === undefined) return undefined;
  if (!isRecord(refreshRaw)) {
    issues.push({ path: "manifest.refresh", message: "refresh must be an object" });
    return undefined;
  }
  const refresh: LiveRefresh = {};
  if (refreshRaw.on_view !== undefined) {
    if (typeof refreshRaw.on_view !== "boolean") {
      issues.push({ path: "manifest.refresh.on_view", message: "on_view must be a boolean" });
    } else {
      refresh.on_view = refreshRaw.on_view;
    }
  }
  for (const key of ["ttl_seconds", "auto_seconds"] as const) {
    if (refreshRaw[key] === undefined) continue;
    const value = refreshRaw[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < LIVE_REFRESH_MIN_SECONDS) {
      issues.push({
        path: `manifest.refresh.${key}`,
        message: `${key} must be an integer of at least ${LIVE_REFRESH_MIN_SECONDS}`,
      });
    } else {
      refresh[key] = value;
    }
  }
  return Object.keys(refresh).length > 0 ? refresh : undefined;
}

export function validateLiveManifest(raw: unknown, program: string): LiveManifest {
  const issues: ArtifactIssue[] = [];
  if (!isRecord(raw)) {
    fail([{ path: "manifest", message: "manifest must be an object" }]);
  }
  const format = raw.format;
  if (typeof format !== "string" || format.trim().length === 0 || format.length > 64) {
    issues.push({ path: "manifest.format", message: "format must be a non-empty string of at most 64 characters" });
  }
  const library = raw.library;
  if (!isRecord(library)) {
    issues.push({ path: "manifest.library", message: "library must be an object with name and version" });
  } else {
    if (typeof library.name !== "string" || library.name.trim().length === 0 || library.name.length > 64) {
      issues.push({ path: "manifest.library.name", message: "library.name must be a non-empty string of at most 64 characters" });
    }
    if (typeof library.version !== "string" || library.version.trim().length === 0 || library.version.length > 32) {
      issues.push({ path: "manifest.library.version", message: "library.version must be a non-empty string of at most 32 characters" });
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, "program")) {
    if (typeof raw.program !== "string") {
      issues.push({ path: "manifest.program", message: "program must be a string" });
    } else if (raw.program !== program) {
      issues.push({ path: "manifest.program", message: "program must match the artifact content" });
    }
  }
  if (Buffer.byteLength(program, "utf8") > LIVE_PROGRAM_MAX_BYTES) {
    throw new ArtifactPublishError(
      413,
      "artifact.too_large",
      `program is larger than ${LIVE_PROGRAM_MAX_BYTES} bytes`,
      [{ path: "program", message: `program is larger than ${LIVE_PROGRAM_MAX_BYTES} bytes` }],
    );
  }
  const bindings = collectLiveBindings(raw.bindings, issues);
  const refresh = collectLiveRefresh(raw.refresh, issues);
  const actions = collectLiveActions(raw.actions, bindings, issues);
  if (issues.length > 0) fail(issues);
  const libraryRecord = library as Record<string, unknown>;
  const manifest: LiveManifest = {
    format: format as string,
    library: { name: libraryRecord.name as string, version: libraryRecord.version as string },
    program,
    bindings,
  };
  if (refresh !== undefined && Object.keys(refresh).length > 0) manifest.refresh = refresh;
  if (actions.length > 0) manifest.actions = actions;
  return manifest;
}

export function liveDbManifest(manifest: LiveManifest): Record<string, unknown> {
  return { kind: LIVE_DECLARATIVE_KIND, ...manifest };
}

/** Identity hash for unchanged detection: program bytes plus canonical manifest JSON. */
export function liveIdentityHash(program: Buffer, manifest: LiveManifest): string {
  return createHash("sha256").update(program).update("\n").update(canonicalJson(manifest)).digest("hex");
}

export function argsHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

export function parseStoredLiveManifest(manifestJson: string | null | undefined): LiveManifest | undefined {
  if (!manifestJson) return undefined;
  try {
    const parsed = JSON.parse(manifestJson) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.bindings)) return undefined;
    if (typeof parsed.format !== "string" || !isRecord(parsed.library)) return undefined;
    const program = typeof parsed.program === "string" ? parsed.program : "";
    return validateLiveManifest(parsed, program);
  } catch (error) {
    if (error instanceof ArtifactPublishError) return undefined;
    return undefined;
  }
}
