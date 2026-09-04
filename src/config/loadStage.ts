import { CLONE_ACTIONS, type CloneAction } from "../types/forkChoice.js";
import {
  STAGE_GATE_KINDS,
  type StageConfig,
  type StageGateKind,
} from "../types/stage.js";
import { compilePayloadSchema } from "../envelope/payloadSchema.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { readYamlObject } from "./readYamlObject.js";

function isGateKind(value: string): value is StageGateKind {
  return (STAGE_GATE_KINDS as readonly string[]).includes(value);
}

function isCloneAction(value: string): value is CloneAction {
  return (CLONE_ACTIONS as readonly string[]).includes(value);
}

function parseCloneActions(
  raw: unknown,
  label: string,
): LoadOutcome<CloneAction[] | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    return loadFailure([
      {
        code: "stage.invalid_clone_actions",
        message: `Invalid stage ${label}: clone_actions must be a non-empty array of strings`,
        category: "stage",
      },
    ]);
  }
  if (raw.length === 0) {
    return loadFailure([
      {
        code: "stage.invalid_clone_actions",
        message: `Invalid stage ${label}: clone_actions must not be empty`,
        category: "stage",
      },
    ]);
  }
  const actions: CloneAction[] = [];
  for (const item of raw) {
    if (!isCloneAction(item)) {
      return loadFailure([
        {
          code: "stage.invalid_clone_actions",
          message: `Invalid stage ${label}: unsupported clone_actions value "${item}" (allowed: ${CLONE_ACTIONS.join(", ")})`,
          category: "stage",
        },
      ]);
    }
    actions.push(item);
  }
  return loadSuccess(actions);
}

function parseTimeoutMs(
  raw: unknown,
  label: string,
): LoadOutcome<number | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw <= 0
  ) {
    return loadFailure([
      {
        code: "stage.invalid_timeout_ms",
        message: `Invalid stage ${label}: timeout_ms must be a positive integer (milliseconds)`,
        category: "stage",
      },
    ]);
  }
  return loadSuccess(raw);
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
  return loadSuccess(kinds);
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

  if (raw.clone_input_schema !== undefined) {
    if (
      raw.clone_input_schema === null ||
      typeof raw.clone_input_schema !== "object" ||
      Array.isArray(raw.clone_input_schema)
    ) {
      return loadFailure([
        {
          code: "stage.invalid_clone_input_schema",
          message: `Invalid stage ${label}: clone_input_schema must be an object`,
          category: "stage",
          stageId: entryId,
        },
      ]);
    }
    try {
      compilePayloadSchema(raw.clone_input_schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return loadFailure([
        {
          code: "stage.invalid_clone_input_schema",
          message: `Invalid stage ${label}: invalid clone_input_schema: ${message}`,
          category: "stage",
          stageId: entryId,
        },
      ]);
    }
    stage.clone_input_schema = raw.clone_input_schema;
  }

  const cloneActionsOutcome = parseCloneActions(raw.clone_actions, label);
  if (!cloneActionsOutcome.ok) {
    const issues: LoadIssue[] = cloneActionsOutcome.issues.map((issue) => ({
      ...issue,
      stageId: entryId,
    }));
    return loadFailure(issues);
  }
  if (cloneActionsOutcome.value !== undefined) {
    stage.clone_actions = cloneActionsOutcome.value;
  }

  const gateKindsOutcome = parseGateKinds(raw.gate_kinds, label);
  if (!gateKindsOutcome.ok) {
    const issues: LoadIssue[] = gateKindsOutcome.issues.map((issue) => ({
      ...issue,
      stageId: entryId,
    }));
    return loadFailure(issues);
  }
  if (gateKindsOutcome.value !== undefined) {
    stage.gate_kinds = gateKindsOutcome.value;
  }

  const timeoutMsOutcome = parseTimeoutMs(raw.timeout_ms, label);
  if (!timeoutMsOutcome.ok) {
    const issues: LoadIssue[] = timeoutMsOutcome.issues.map((issue) => ({
      ...issue,
      stageId: entryId,
    }));
    return loadFailure(issues);
  }
  if (timeoutMsOutcome.value !== undefined) {
    stage.timeout_ms = timeoutMsOutcome.value;
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
