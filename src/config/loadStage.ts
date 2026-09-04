import {
  STAGE_GATE_KINDS,
  type StageConfig,
  type StageGateKind,
} from "../types/stage.js";
import { compilePayloadSchema } from "../envelope/payloadSchema.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { parsePreEmitChecks } from "./parsePreEmitChecks.js";
import { readYamlObject } from "./readYamlObject.js";

function isGateKind(value: string): value is StageGateKind {
  return (STAGE_GATE_KINDS as readonly string[]).includes(value);
}

function parseGateKinds(
  raw: unknown,
  label: string,
): LoadOutcome<StageGateKind[] | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    return loadFailure([
      {
        code: "stage.invalid_gate_kinds",
        message: `Invalid stage ${label}: gate_kinds must be an array of strings`,
        category: "stage",
      },
    ]);
  }
  const kinds: StageGateKind[] = [];
  for (const item of raw) {
    if (!isGateKind(item)) {
      return loadFailure([
        {
          code: "stage.invalid_gate_kinds",
          message: `Invalid stage ${label}: unsupported gate kind "${item}" (allowed: ${STAGE_GATE_KINDS.join(", ")})`,
          category: "stage",
        },
      ]);
    }
    kinds.push(item);
  }
  return loadSuccess(kinds.length > 0 ? kinds : undefined);
}

function parseStageFields(
  raw: Record<string, unknown>,
  label: string,
  entryId: string,
): LoadOutcome<StageConfig> {
  if (
    typeof raw.system_prompt !== "string" ||
    typeof raw.model !== "string"
  ) {
    return loadFailure([
      {
        code: "stage.invalid_shape",
        message: `Invalid stage ${label}: system_prompt and model are required strings`,
        category: "stage",
        stageId: entryId,
      },
    ]);
  }

  const stage: StageConfig = {
    id: entryId,
    system_prompt: raw.system_prompt,
    model: raw.model,
  };

  if (raw.payload_schema !== undefined) {
    if (
      raw.payload_schema === null ||
      typeof raw.payload_schema !== "object" ||
      Array.isArray(raw.payload_schema)
    ) {
      return loadFailure([
        {
          code: "stage.invalid_payload_schema",
          message: `Invalid stage ${label}: payload_schema must be an object`,
          category: "stage",
          stageId: entryId,
        },
      ]);
    }
    try {
      compilePayloadSchema(raw.payload_schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return loadFailure([
        {
          code: "stage.invalid_payload_schema",
          message: `Invalid stage ${label}: invalid payload_schema: ${message}`,
          category: "stage",
          stageId: entryId,
        },
      ]);
    }
    stage.payload_schema = raw.payload_schema;
  }

  const gateKindsOutcome = parseGateKinds(raw.gate_kinds, label);
  if (!gateKindsOutcome.ok) {
    const issues: LoadIssue[] = gateKindsOutcome.issues.map((issue) => ({
      ...issue,
      stageId: entryId,
    }));
    return loadFailure(issues);
  }
  if (gateKindsOutcome.value) stage.gate_kinds = gateKindsOutcome.value;

  const preEmitChecksOutcome = parsePreEmitChecks(raw.pre_emit_checks, label);
  if (!preEmitChecksOutcome.ok) {
    const issues: LoadIssue[] = preEmitChecksOutcome.issues.map((issue) => ({
      ...issue,
      stageId: entryId,
    }));
    return loadFailure(issues);
  }
  if (preEmitChecksOutcome.value !== undefined) {
    stage.pre_emit_checks = preEmitChecksOutcome.value;
  }

  if (raw.skill !== undefined) {
    if (typeof raw.skill !== "string" || raw.skill.trim() === "") {
      return loadFailure([
        {
          code: "stage.invalid_skill",
          message: `Invalid stage ${label}: skill must be a non-empty string`,
          category: "stage",
          stageId: entryId,
        },
      ]);
    }
    stage.skill = raw.skill.trim();
  }

  return loadSuccess(stage);
}

export function loadStageFromObjectOutcome(
  raw: Record<string, unknown>,
  ctx: { entryId: string; declaringPath: string },
): LoadOutcome<StageConfig> {
  const label = `${ctx.entryId} (${ctx.declaringPath})`;
  return parseStageFields(raw, label, ctx.entryId);
}

export async function loadStageOutcome(filePath: string): Promise<LoadOutcome<StageConfig>> {
  let raw: Record<string, unknown>;
  try {
    raw = await readYamlObject(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "stage.load_error",
        message,
        category: "stage",
      },
    ]);
  }

  if (typeof raw?.id !== "string") {
    return loadFailure([
      {
        code: "stage.invalid_shape",
        message: `Invalid stage file ${filePath}: id, system_prompt, and model are required strings`,
        category: "stage",
      },
    ]);
  }

  const outcome = parseStageFields(raw, `file ${filePath}`, raw.id);
  if (!outcome.ok) return outcome;
  if (outcome.value.id !== raw.id) {
    return loadFailure([
      {
        code: "stage.invalid_shape",
        message: `Invalid stage file ${filePath}: id mismatch`,
        category: "stage",
        stageId: raw.id,
      },
    ]);
  }
  return outcome;
}

export async function loadStage(filePath: string): Promise<StageConfig> {
  const outcome = await loadStageOutcome(filePath);
  if (!outcome.ok) {
    throw new Error(outcome.issues[0].message);
  }
  return outcome.value;
}
