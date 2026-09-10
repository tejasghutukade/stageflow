import { stringify as stringifyYaml } from "yaml";
import type { CompletionCheck } from "../types/completion.js";
import type { PreEmitCheck } from "../types/preEmitCheck.js";
import type { StageIoYaml } from "../types/stage.js";
import { LEGACY_CONTRACT_KEYS, STAGE_FILE_WIRING_KEYS, TARGET_CONTRACT_KEYS } from "./yamlDialect.js";

export type VerifyPhase = "emit" | "after";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function uniquePhases(phases: VerifyPhase[]): VerifyPhase[] {
  const seen = new Set<VerifyPhase>();
  const next: VerifyPhase[] = [];
  for (const phase of phases) {
    if (seen.has(phase)) continue;
    seen.add(phase);
    next.push(phase);
  }
  return next;
}

function artifactTypesCompatible(a: string, b: string): boolean {
  const artifact = a === "artifact" || a === "artifact_declared";
  const other = b === "artifact" || b === "artifact_declared";
  return artifact && other;
}

function typesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  return artifactTypesCompatible(a, b);
}

function preEmitToItem(check: PreEmitCheck): Record<string, unknown> {
  if (check.type === "artifact_declared") {
    return {
      id: check.id,
      type: "artifact",
      basename: check.basename,
      when: ["emit"],
    };
  }
  return { ...check, when: ["emit"] };
}

function afterCheckToItem(check: CompletionCheck): Record<string, unknown> {
  return { ...check, when: ["after"] };
}

function mergeVerifyItems(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { ok: true; item: Record<string, unknown> } | { ok: false; error: string } {
  const existingType = String(existing.type);
  const incomingType = String(incoming.type);
  if (!typesCompatible(existingType, incomingType)) {
    return {
      ok: false,
      error: `verify id "${String(existing.id)}" cannot merge types "${existingType}" and "${incomingType}"`,
    };
  }
  const existingWhen = Array.isArray(existing.when) ? (existing.when as VerifyPhase[]) : [];
  const incomingWhen = Array.isArray(incoming.when) ? (incoming.when as VerifyPhase[]) : [];
  const merged: Record<string, unknown> = { ...existing };
  if (artifactTypesCompatible(existingType, incomingType)) {
    merged.type = "artifact";
    if (typeof incoming.path === "string") merged.path = incoming.path;
    if (typeof incoming.basename === "string" && merged.path === undefined) {
      merged.basename = incoming.basename;
    }
    if (typeof incoming.nonempty === "boolean") merged.nonempty = incoming.nonempty;
    if (typeof existing.basename === "string" && typeof merged.path === "string") {
      const base = merged.path.split(/[\\/]/).pop();
      if (base === existing.basename) delete merged.basename;
    }
  } else {
    for (const [key, value] of Object.entries(incoming)) {
      if (key === "when" || key === "id" || key === "type") continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  merged.when = uniquePhases([...existingWhen, ...incomingWhen]);
  return { ok: true, item: merged };
}

export function buildVerifyItems(
  preEmit: PreEmitCheck[] | undefined,
  afterChecks: CompletionCheck[] | undefined,
): { ok: true; items: Record<string, unknown>[] } | { ok: false; error: string } {
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];

  const add = (item: Record<string, unknown>): { ok: false; error: string } | undefined => {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return { ok: false, error: "verify item is missing id" };
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, item);
      order.push(id);
      return undefined;
    }
    const merged = mergeVerifyItems(existing, item);
    if (!merged.ok) return { ok: false, error: merged.error };
    byId.set(id, merged.item);
    return undefined;
  };

  for (const check of preEmit ?? []) {
    const failed = add(preEmitToItem(check));
    if (failed) return failed;
  }
  for (const check of afterChecks ?? []) {
    const failed = add(afterCheckToItem(check));
    if (failed) return failed;
  }

  return { ok: true, items: order.map((id) => byId.get(id)!) };
}

export function ioFromSchemas(stage: {
  payload_schema?: unknown;
  clone_input_schema?: unknown;
}): StageIoYaml | undefined {
  const io: StageIoYaml = {};
  if (stage.clone_input_schema !== undefined) {
    io.input = { schema: stage.clone_input_schema };
  }
  if (stage.payload_schema !== undefined) {
    io.output = { schema: stage.payload_schema };
  }
  return io.input !== undefined || io.output !== undefined ? io : undefined;
}

export function ioFromRawDocument(raw: Record<string, unknown>): StageIoYaml | undefined {
  if (isPlainObject(raw.io)) return raw.io as StageIoYaml;
  return ioFromSchemas({
    payload_schema: raw.payload_schema,
    clone_input_schema: raw.clone_input_schema,
  });
}

function dropContractKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (LEGACY_CONTRACT_KEYS.has(key) || TARGET_CONTRACT_KEYS.has(key)) continue;
    next[key] = value;
  }
  return next;
}

const STAGE_BODY_ORDER = [
  "id",
  "system_prompt",
  "model",
  "agent",
  "timeout_ms",
  "io",
  "verify",
  "gate_kinds",
  "clone_actions",
  "skill",
  "mcp",
] as const;

const PIPELINE_WIRING_ORDER = [
  "id",
  "uses",
  "skill",
  "mcp",
  "needs",
  "fork",
  "clonable",
  "clone_cap",
  "on_verify_fail",
  "feedback_loop",
  "replay_safe",
] as const;

function orderKeys(
  raw: Record<string, unknown>,
  preferred: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of preferred) {
    if (raw[key] !== undefined) next[key] = raw[key];
  }
  for (const key of Object.keys(raw)) {
    if (next[key] !== undefined) continue;
    next[key] = raw[key];
  }
  return next;
}

export function rewriteStageDocument(
  raw: Record<string, unknown>,
  compiled: { io?: StageIoYaml; verify?: Record<string, unknown>[] },
): Record<string, unknown> {
  const next = dropContractKeys(raw);
  for (const key of STAGE_FILE_WIRING_KEYS) {
    delete next[key];
  }
  if (compiled.io !== undefined) next.io = compiled.io;
  if (compiled.verify !== undefined && compiled.verify.length > 0) {
    next.verify = compiled.verify;
  }
  return orderKeys(next, STAGE_BODY_ORDER);
}

export function rewritePipelineStageEntry(
  raw: Record<string, unknown>,
  compiled: {
    uses?: string;
    io?: StageIoYaml;
    verify?: Record<string, unknown>[];
    on_verify_fail?: unknown;
  },
): Record<string, unknown> {
  const next = dropContractKeys(raw);
  if (compiled.uses !== undefined) {
    next.uses = compiled.uses;
    delete next.system_prompt;
    delete next.model;
    delete next.agent;
    delete next.timeout_ms;
    delete next.gate_kinds;
    delete next.clone_actions;
    delete next.io;
    delete next.verify;
    if (compiled.on_verify_fail !== undefined) next.on_verify_fail = compiled.on_verify_fail;
    else delete next.on_verify_fail;
    return orderKeys(next, PIPELINE_WIRING_ORDER);
  }
  if (compiled.io !== undefined) next.io = compiled.io;
  else delete next.io;
  if (compiled.verify !== undefined && compiled.verify.length > 0) next.verify = compiled.verify;
  else delete next.verify;
  if (compiled.on_verify_fail !== undefined) next.on_verify_fail = compiled.on_verify_fail;
  else delete next.on_verify_fail;
  return orderKeys(next, [...STAGE_BODY_ORDER, ...PIPELINE_WIRING_ORDER]);
}

export function rewriteCatalogDocument(
  raw: Record<string, unknown>,
  rewriteEntry: (entry: Record<string, unknown>, index: number) => Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "stages" && Array.isArray(value)) {
      next.stages = value.map((entry, index) => {
        if (!isPlainObject(entry)) return entry;
        return rewriteEntry(entry, index);
      });
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function stringifyTargetYaml(doc: unknown): string {
  const text = stringifyYaml(doc, { indent: 2, lineWidth: 0 });
  return text.endsWith("\n") ? text : `${text}\n`;
}
