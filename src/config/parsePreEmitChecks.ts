import { STAGE_GATE_KINDS, type StageGateKind } from "../types/stage.js";
import type { PreEmitCheck } from "../types/preEmitCheck.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGateKind(value: unknown): value is StageGateKind {
  return typeof value === "string" && (STAGE_GATE_KINDS as readonly string[]).includes(value);
}

function failure(label: string, message: string): LoadOutcome<never> {
  return loadFailure([
    {
      code: "stage.invalid_pre_emit_checks",
      message: `Invalid stage ${label}: pre_emit_checks ${message}`,
      category: "stage",
    },
  ]);
}

function parsePreEmitCheck(
  raw: unknown,
  label: string,
  index: number,
): LoadOutcome<PreEmitCheck> {
  if (!isPlainObject(raw)) {
    return failure(label, `[${index}] must be an object`);
  }
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return failure(label, `[${index}].id must be a non-empty string`);
  }
  if (typeof raw.type !== "string") {
    return failure(label, `[${index}].type must be a string`);
  }
  const id = raw.id.trim();

  if (raw.type === "gate") {
    if (!isGateKind(raw.kind)) {
      return failure(
        label,
        `[${index}].kind must be one of ${STAGE_GATE_KINDS.join(", ")}`,
      );
    }
    return loadSuccess({ id, type: "gate", kind: raw.kind });
  }

  if (raw.type === "artifact_declared") {
    if (typeof raw.basename !== "string" || raw.basename.trim() === "") {
      return failure(
        label,
        `[${index}].basename must be a non-empty string`,
      );
    }
    return loadSuccess({
      id,
      type: "artifact_declared",
      basename: raw.basename.trim(),
    });
  }

  return failure(label, `[${index}].type "${raw.type}" is unsupported`);
}

export function parsePreEmitChecks(
  raw: unknown,
  label: string,
): LoadOutcome<PreEmitCheck[] | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!Array.isArray(raw) || raw.length === 0) {
    return failure(label, "must be a non-empty array");
  }

  const checks: PreEmitCheck[] = [];
  for (let index = 0; index < raw.length; index++) {
    const outcome = parsePreEmitCheck(raw[index], label, index);
    if (!outcome.ok) return outcome;
    checks.push(outcome.value);
  }

  const duplicate = checks.find(
    (check, index) => checks.findIndex((item) => item.id === check.id) !== index,
  );
  if (duplicate) {
    return failure(label, `id "${duplicate.id}" is duplicated`);
  }

  return loadSuccess(checks);
}
