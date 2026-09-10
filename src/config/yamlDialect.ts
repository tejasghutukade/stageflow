/**
 * Target YAML dialect compiler.
 *
 * Catalog files (and new catalog fields) use `io`, `verify`, and `on_verify_fail`.
 * Runtime, DAG snapshots, emit, and VSE still speak the IR names this module
 * writes. Dual-read of old YAML keys (`payload_schema`, `pre_emit_checks`,
 * `completion`, `recovery`) is `legacyYaml.ts` — not this compiler.
 *
 * YAML → IR
 *   io.output.schema              → StageConfig.payload_schema
 *   io.input.schema               → StageConfig.clone_input_schema
 *   verify when includes emit     → StageConfig.pre_emit_checks
 *   verify when includes after     → DAG node.completion
 *   on_verify_fail                → DAG node.recovery
 *
 * `type: payload_schema` on a verify item is a check kind, not the legacy
 * authoring key. Adding a catalog contract: extend TARGET_CONTRACT_KEYS and
 * compileTargetContract (and printTargetYaml for migrate). Do not add a new
 * LEGACY_CONTRACT_KEYS entry.
 */
import path from "node:path";
import {
  compilePayloadSchema,
  UnresolvedSchemaRefError,
} from "../envelope/payloadSchema.js";
import type { CompletionContract, RecoveryPolicy } from "../types/completion.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { parseExecutionPolicy } from "./parseCompletionContract.js";
import { LEGACY_CONTRACT_KEYS } from "./legacyYaml.js";

export {
  LEGACY_CONTRACT_KEYS,
  LEGACY_KEY_REPLACEMENTS,
  dialectWarningForDocument,
  formatLegacyReplacements,
  legacyYamlIssue,
  presentLegacyKeys,
} from "./legacyYaml.js";

/** Target authoring keys. New catalog contracts belong here, not on the IR field names. */
export const TARGET_CONTRACT_KEYS = new Set(["io", "verify", "on_verify_fail"]);

/** Target wiring on a stage *file* is forbidden (`on_verify_fail`). `completion`/`recovery` are IR/legacy keys. */
export const STAGE_FILE_WIRING_KEYS = [
  "needs",
  "on_verify_fail",
  "completion",
  "recovery",
  "fork",
  "clonable",
] as const;

export type YamlDialect = "legacy" | "target" | "invalid" | "neutral";

/** Target YAML compiled onto IR field names (see file comment). */
export type CompiledTargetContract = {
  payload_schema?: unknown;
  clone_input_schema?: unknown;
  pre_emit_raw?: unknown[];
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dialectFromKeys(keys: Iterable<string>): YamlDialect {
  let legacy = false;
  let target = false;
  for (const key of keys) {
    if (LEGACY_CONTRACT_KEYS.has(key)) legacy = true;
    if (TARGET_CONTRACT_KEYS.has(key)) target = true;
  }
  if (legacy && target) return "invalid";
  if (legacy) return "legacy";
  if (target) return "target";
  return "neutral";
}

export function collectDocumentKeys(raw: Record<string, unknown>): Set<string> {
  const keys = new Set(Object.keys(raw));
  if (Array.isArray(raw.stages)) {
    for (const entry of raw.stages) {
      if (isPlainObject(entry)) {
        for (const key of Object.keys(entry)) keys.add(key);
      }
    }
  }
  return keys;
}

export function classifyYamlDocument(raw: Record<string, unknown>): YamlDialect {
  return dialectFromKeys(collectDocumentKeys(raw));
}

export function mixedDialectIssue(message?: string): LoadIssue {
  return {
    code: "catalog.mixed_yaml_dialect",
    message:
      message ??
      "YAML mixes legacy and target contract keys; use one dialect per file",
    category: "catalog",
  };
}

function invalidIo(label: string, message: string, stageId?: string): LoadOutcome<never> {
  return loadFailure([
    {
      code: "stage.invalid_io",
      message: `Invalid stage ${label}: ${message}`,
      category: "stage",
      stageId,
    },
  ]);
}

function invalidVerify(
  stageId: string,
  message: string,
  category: "pipeline" | "stage",
): LoadOutcome<never> {
  return loadFailure([
    {
      code: "pipeline.invalid_verify",
      message: `Stage "${stageId}" verify: ${message}`,
      category,
    },
  ]);
}

function parseIo(
  raw: unknown,
  label: string,
  stageId: string,
  deferSchemaRefs: boolean,
): LoadOutcome<{ payload_schema?: unknown; clone_input_schema?: unknown }> {
  if (raw === undefined) return loadSuccess({});
  if (!isPlainObject(raw)) {
    return invalidIo(label, "io must be an object", stageId);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "input" && key !== "output") {
      return invalidIo(label, `io: unknown key "${key}"`, stageId);
    }
  }

  const result: { payload_schema?: unknown; clone_input_schema?: unknown } = {};

  for (const [field, target] of [
    ["output", "payload_schema"],
    ["input", "clone_input_schema"],
  ] as const) {
    const side = raw[field];
    if (side === undefined) continue;
    if (!isPlainObject(side)) {
      return invalidIo(label, `io.${field} must be an object`, stageId);
    }
    for (const key of Object.keys(side)) {
      if (key !== "schema") {
        return invalidIo(label, `io.${field}: unknown key "${key}"`, stageId);
      }
    }
    if (side.schema === undefined) continue;
    if (side.schema === null || typeof side.schema !== "object" || Array.isArray(side.schema)) {
      return invalidIo(label, `io.${field}.schema must be an object`, stageId);
    }
    try {
      compilePayloadSchema(side.schema);
    } catch (err) {
      if (err instanceof UnresolvedSchemaRefError) {
        if (deferSchemaRefs) {
          if (target === "payload_schema") result.payload_schema = side.schema;
          else result.clone_input_schema = side.schema;
          continue;
        }
        return loadFailure([
          {
            code: "stage.unresolved_schema_ref",
            message: `Invalid stage ${label}: ${err.message}`,
            category: "stage",
            stageId,
          },
        ]);
      }
      const message = err instanceof Error ? err.message : String(err);
      return invalidIo(label, `invalid io.${field}.schema: ${message}`, stageId);
    }
    if (target === "payload_schema") result.payload_schema = side.schema;
    else result.clone_input_schema = side.schema;
  }

  return loadSuccess(result);
}

type VerifyPhase = "emit" | "after";

const EMIT_LEGAL_TYPES = new Set(["gate", "artifact"]);

function parseVerifyWhen(
  item: Record<string, unknown>,
  type: string,
  stageId: string,
  index: number,
  category: "pipeline" | "stage",
): LoadOutcome<VerifyPhase[]> {
  if (item.when === undefined) {
    if (type === "artifact") {
      return invalidVerify(stageId, `[${index}] type artifact requires when`, category);
    }
    if (type === "gate") return loadSuccess(["emit"]);
    return loadSuccess(["after"]);
  }
  if (!Array.isArray(item.when) || item.when.length === 0) {
    return invalidVerify(
      stageId,
      `[${index}].when must be a non-empty array of emit and/or after`,
      category,
    );
  }
  const phases: VerifyPhase[] = [];
  const seen = new Set<string>();
  for (const value of item.when) {
    if (value !== "emit" && value !== "after") {
      return invalidVerify(
        stageId,
        `[${index}].when must be a non-empty unique subset of emit, after`,
        category,
      );
    }
    if (seen.has(value)) {
      return invalidVerify(stageId, `[${index}].when must not contain duplicates`, category);
    }
    seen.add(value);
    phases.push(value);
  }
  if (phases.includes("emit") && !EMIT_LEGAL_TYPES.has(type)) {
    return invalidVerify(
      stageId,
      `[${index}] type "${type}" cannot use when: emit`,
      category,
    );
  }
  return loadSuccess(phases);
}

function withoutWhen(item: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key !== "when") next[key] = value;
  }
  return next;
}

function emitArtifactRaw(
  item: Record<string, unknown>,
  stageId: string,
  index: number,
  category: "pipeline" | "stage",
): LoadOutcome<Record<string, unknown>> {
  const basenameSource =
    typeof item.basename === "string" && item.basename.trim()
      ? item.basename.trim()
      : typeof item.path === "string" && item.path.trim()
        ? path.basename(item.path.trim())
        : "";
  if (!basenameSource) {
    return invalidVerify(
      stageId,
      `[${index}] emit artifact requires path or basename`,
      category,
    );
  }
  return loadSuccess({
    id: item.id,
    type: "artifact_declared",
    basename: basenameSource,
  });
}

function afterArtifactRaw(
  item: Record<string, unknown>,
  stageId: string,
  index: number,
  category: "pipeline" | "stage",
): LoadOutcome<Record<string, unknown>> {
  const artifactPath =
    typeof item.path === "string" && item.path.trim()
      ? item.path.trim()
      : typeof item.basename === "string" && item.basename.trim()
        ? item.basename.trim()
        : "";
  if (!artifactPath) {
    return invalidVerify(
      stageId,
      `[${index}] after artifact requires path or basename`,
      category,
    );
  }
  if (item.nonempty !== undefined && typeof item.nonempty !== "boolean") {
    return invalidVerify(stageId, `[${index}].nonempty must be a boolean`, category);
  }
  return loadSuccess({
    id: item.id,
    type: "artifact",
    path: artifactPath,
    ...(typeof item.nonempty === "boolean" ? { nonempty: item.nonempty } : {}),
  });
}

function parseVerifyList(
  raw: unknown,
  stageId: string,
  category: "pipeline" | "stage",
): LoadOutcome<{ pre_emit_raw?: unknown[]; completionRaw?: unknown }> {
  if (raw === undefined) return loadSuccess({});
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalidVerify(stageId, "must be a non-empty array", category);
  }

  const preEmit: unknown[] = [];
  const afterChecks: unknown[] = [];

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isPlainObject(item)) {
      return invalidVerify(stageId, `[${index}] must be an object`, category);
    }
    if (typeof item.type !== "string" || item.type.trim() === "") {
      return invalidVerify(stageId, `[${index}].type must be a string`, category);
    }
    const type = item.type.trim();
    const whenOutcome = parseVerifyWhen(item, type, stageId, index, category);
    if (!whenOutcome.ok) return whenOutcome;
    const stripped = withoutWhen(item);

    if (whenOutcome.value.includes("emit")) {
      if (type === "artifact") {
        const emitRaw = emitArtifactRaw(item, stageId, index, category);
        if (!emitRaw.ok) return emitRaw;
        preEmit.push(emitRaw.value);
      } else {
        preEmit.push(stripped);
      }
    }
    if (whenOutcome.value.includes("after")) {
      if (type === "artifact") {
        const afterRaw = afterArtifactRaw(item, stageId, index, category);
        if (!afterRaw.ok) return afterRaw;
        afterChecks.push(afterRaw.value);
      } else {
        afterChecks.push(stripped);
      }
    }
  }

  return loadSuccess({
    ...(preEmit.length > 0 ? { pre_emit_raw: preEmit } : {}),
    ...(afterChecks.length > 0 ? { completionRaw: { mode: "all", checks: afterChecks } } : {}),
  });
}

/** Compile target YAML (`io` / `verify` / `on_verify_fail`) onto IR fields. */
export function compileTargetContract(
  raw: Record<string, unknown>,
  ctx: {
    stageId: string;
    label: string;
    category: "pipeline" | "stage";
    deferSchemaRefs?: boolean;
  },
): LoadOutcome<CompiledTargetContract> {
  const ioOutcome = parseIo(raw.io, ctx.label, ctx.stageId, ctx.deferSchemaRefs === true);
  if (!ioOutcome.ok) return ioOutcome;

  const verifyOutcome = parseVerifyList(raw.verify, ctx.stageId, ctx.category);
  if (!verifyOutcome.ok) return verifyOutcome;

  const policyOutcome = parseExecutionPolicy(
    {
      completion: verifyOutcome.value.completionRaw,
      recovery: raw.on_verify_fail,
    },
    ctx.stageId,
    { requireCompletionForRecovery: false },
  );
  if (!policyOutcome.ok) return policyOutcome;

  return loadSuccess({
    ...ioOutcome.value,
    ...(verifyOutcome.value.pre_emit_raw !== undefined
      ? { pre_emit_raw: verifyOutcome.value.pre_emit_raw }
      : {}),
    ...(policyOutcome.value.completion !== undefined
      ? { completion: policyOutcome.value.completion }
      : {}),
    ...(policyOutcome.value.recovery !== undefined
      ? { recovery: policyOutcome.value.recovery }
      : {}),
  });
}

/** Strip target YAML keys and stamp IR `payload_schema` / `clone_input_schema` / `pre_emit_checks`. */
export function applyCompiledBody(
  raw: Record<string, unknown>,
  compiled: CompiledTargetContract,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "io" || key === "verify" || key === "on_verify_fail") continue;
    next[key] = value;
  }
  if (compiled.payload_schema !== undefined) next.payload_schema = compiled.payload_schema;
  if (compiled.clone_input_schema !== undefined) {
    next.clone_input_schema = compiled.clone_input_schema;
  }
  if (compiled.pre_emit_raw !== undefined) next.pre_emit_checks = compiled.pre_emit_raw;
  return next;
}
