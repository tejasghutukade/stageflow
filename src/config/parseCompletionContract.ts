import path from "node:path";
import type {
  CompletionCheck,
  CompletionContract,
  RecoveryPolicy,
} from "../types/completion.js";
import { STAGE_GATE_KINDS, type StageGateKind } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";

type ExecutionPolicy = {
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  stageId: string,
  field: "completion" | "recovery",
  message: string,
): LoadOutcome<never> {
  return loadFailure([
    {
      code:
        field === "completion"
          ? "pipeline.invalid_completion"
          : "pipeline.invalid_recovery",
      message: `Stage "${stageId}" ${field}: ${message}`,
      category: "pipeline",
    },
  ]);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isGateKind(value: unknown): value is StageGateKind {
  return typeof value === "string" && (STAGE_GATE_KINDS as readonly string[]).includes(value);
}

function parsePathFields(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    return undefined;
  }
  const fields = value.map((item) => item.trim());
  return new Set(fields).size === fields.length ? fields : undefined;
}

function parseCheck(
  raw: unknown,
  stageId: string,
  index: number,
): LoadOutcome<CompletionCheck> {
  if (!isPlainObject(raw)) {
    return failure(stageId, "completion", `checks[${index}] must be an object`);
  }
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return failure(stageId, "completion", `checks[${index}].id must be a non-empty string`);
  }
  if (typeof raw.type !== "string") {
    return failure(stageId, "completion", `checks[${index}].type must be a string`);
  }
  const id = raw.id.trim();

  if (raw.type === "command") {
    const unknown = hasOnlyKeys(raw, ["id", "type", "run", "cwd", "timeout_ms"]);
    if (unknown) return failure(stageId, "completion", `checks[${index}]: unknown key "${unknown}"`);
    if (typeof raw.run !== "string" || raw.run.trim() === "") {
      return failure(stageId, "completion", `checks[${index}] command check requires a non-empty run`);
    }
    if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || raw.cwd.trim() === "")) {
      return failure(stageId, "completion", `checks[${index}].cwd must be a non-empty string`);
    }
    if (raw.timeout_ms !== undefined && !isPositiveInteger(raw.timeout_ms)) {
      return failure(stageId, "completion", `checks[${index}].timeout_ms must be a positive integer`);
    }
    return loadSuccess({
      id,
      type: "command",
      run: raw.run.trim(),
      ...(typeof raw.cwd === "string" ? { cwd: raw.cwd.trim() } : {}),
      ...(typeof raw.timeout_ms === "number" ? { timeout_ms: raw.timeout_ms } : {}),
    });
  }

  if (raw.type === "artifact") {
    const unknown = hasOnlyKeys(raw, ["id", "type", "path", "nonempty"]);
    if (unknown) return failure(stageId, "completion", `checks[${index}]: unknown key "${unknown}"`);
    if (typeof raw.path !== "string" || raw.path.trim() === "") {
      return failure(stageId, "completion", `checks[${index}] artifact check requires a non-empty path`);
    }
    const artifactPath = raw.path.trim();
    const normalizedPath = path.normalize(artifactPath);
    if (
      path.isAbsolute(artifactPath) ||
      normalizedPath === ".." ||
      normalizedPath.startsWith(`..${path.sep}`)
    ) {
      return failure(stageId, "completion", `checks[${index}] artifact path must stay inside the attempt artifact directory`);
    }
    if (raw.nonempty !== undefined && typeof raw.nonempty !== "boolean") {
      return failure(stageId, "completion", `checks[${index}].nonempty must be a boolean`);
    }
    return loadSuccess({
      id,
      type: "artifact",
      path: artifactPath,
      ...(typeof raw.nonempty === "boolean" ? { nonempty: raw.nonempty } : {}),
    });
  }

  if (raw.type === "checklist") {
    const unknown = hasOnlyKeys(raw, ["id", "type", "items"]);
    if (unknown) return failure(stageId, "completion", `checks[${index}]: unknown key "${unknown}"`);
    if (
      !Array.isArray(raw.items) ||
      raw.items.length === 0 ||
      !raw.items.every((item) => typeof item === "string" && item.trim() !== "")
    ) {
      return failure(stageId, "completion", `checks[${index}] checklist requires a non-empty items array of strings`);
    }
    const items = raw.items.map((item) => item.trim());
    if (new Set(items).size !== items.length) {
      return failure(stageId, "completion", `checks[${index}] checklist items must be unique`);
    }
    return loadSuccess({ id, type: "checklist", items });
  }

  if (raw.type === "payload_schema") {
    const unknown = hasOnlyKeys(raw, ["id", "type"]);
    if (unknown) return failure(stageId, "completion", `checks[${index}]: unknown key "${unknown}"`);
    return loadSuccess({ id, type: "payload_schema" });
  }

  if (raw.type === "gate") {
    const unknown = hasOnlyKeys(raw, ["id", "type", "kind"]);
    if (unknown) return failure(stageId, "completion", `checks[${index}]: unknown key "${unknown}"`);
    if (!isGateKind(raw.kind)) {
      return failure(stageId, "completion", `checks[${index}].kind must be one of ${STAGE_GATE_KINDS.join(", ")}`);
    }
    return loadSuccess({ id, type: "gate", kind: raw.kind });
  }

  if (raw.type === "checkout_changes") {
    const unknown = hasOnlyKeys(raw, ["id", "type", "path_fields"]);
    if (unknown) return failure(stageId, "completion", `checks[${index}]: unknown key "${unknown}"`);
    const pathFields = parsePathFields(raw.path_fields);
    if (raw.path_fields !== undefined && pathFields === undefined) {
      return failure(stageId, "completion", `checks[${index}].path_fields must be a unique, non-empty array of strings`);
    }
    return loadSuccess({
      id,
      type: "checkout_changes",
      ...(pathFields !== undefined ? { path_fields: pathFields } : {}),
    });
  }

  return failure(stageId, "completion", `checks[${index}].type "${raw.type}" is unsupported`);
}

function parseCompletion(
  raw: unknown,
  stageId: string,
): LoadOutcome<CompletionContract | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!isPlainObject(raw)) return failure(stageId, "completion", "must be an object");
  const unknown = hasOnlyKeys(raw, ["mode", "checks"]);
  if (unknown) return failure(stageId, "completion", `unknown key "${unknown}"`);
  if (raw.mode !== undefined && raw.mode !== "all") {
    return failure(stageId, "completion", 'mode must be "all"');
  }
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    return failure(stageId, "completion", "checks must be a non-empty array");
  }
  const checks: CompletionCheck[] = [];
  for (let index = 0; index < raw.checks.length; index++) {
    const outcome = parseCheck(raw.checks[index], stageId, index);
    if (!outcome.ok) return outcome;
    checks.push(outcome.value);
  }
  const duplicates = checks.find((check, index) => checks.findIndex((item) => item.id === check.id) !== index);
  if (duplicates) return failure(stageId, "completion", `check id "${duplicates.id}" is duplicated`);
  return loadSuccess({ mode: "all", checks });
}

function parseRecovery(
  raw: unknown,
  stageId: string,
  hasCompletion: boolean,
): LoadOutcome<RecoveryPolicy | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!hasCompletion) return failure(stageId, "recovery", "requires a completion contract");
  if (!isPlainObject(raw)) return failure(stageId, "recovery", "must be an object");
  const unknown = hasOnlyKeys(raw, ["mode", "max_attempts", "retry_safety", "include_failed_checks"]);
  if (unknown) return failure(stageId, "recovery", `unknown key "${unknown}"`);
  if (raw.mode !== "repair" && raw.mode !== "manual") {
    return failure(stageId, "recovery", 'mode must be "repair" or "manual"');
  }
  if (raw.retry_safety !== "idempotent" && raw.retry_safety !== "side_effecting") {
    return failure(stageId, "recovery", 'retry_safety must be "idempotent" or "side_effecting"');
  }
  if (raw.include_failed_checks !== undefined && typeof raw.include_failed_checks !== "boolean") {
    return failure(stageId, "recovery", "include_failed_checks must be a boolean");
  }
  if (raw.mode === "repair") {
    if (!isPositiveInteger(raw.max_attempts)) {
      return failure(stageId, "recovery", "repair requires max_attempts to be a positive integer");
    }
    if (raw.retry_safety !== "idempotent") {
      return failure(stageId, "recovery", "automatic repair requires retry_safety: idempotent");
    }
    return loadSuccess({
      mode: "repair",
      max_attempts: raw.max_attempts,
      retry_safety: "idempotent",
      include_failed_checks: raw.include_failed_checks ?? true,
    });
  }
  return loadSuccess({
    mode: "manual",
    retry_safety: raw.retry_safety,
    ...(typeof raw.include_failed_checks === "boolean"
      ? { include_failed_checks: raw.include_failed_checks }
      : {}),
  });
}

export function parseExecutionPolicy(
  raw: Record<string, unknown>,
  stageId: string,
): LoadOutcome<ExecutionPolicy> {
  const completion = parseCompletion(raw.completion, stageId);
  if (!completion.ok) return completion;
  const recovery = parseRecovery(raw.recovery, stageId, completion.value !== undefined);
  if (!recovery.ok) return recovery;
  return loadSuccess({
    ...(completion.value !== undefined ? { completion: completion.value } : {}),
    ...(recovery.value !== undefined ? { recovery: recovery.value } : {}),
  });
}
