import { parseAgentField } from "../agent/agentBackend.js";
import { STAGEFLOW_MCP_SERVER_NAME } from "../agent/claudeTools.js";
import { CLONE_ACTIONS, type CloneAction } from "../types/forkChoice.js";
import type { CompletionContract } from "../types/completion.js";
import {
  STAGE_GATE_KINDS,
  type StageConfig,
  type StageGateKind,
} from "../types/stage.js";
import { compilePayloadSchema, UnresolvedSchemaRefError } from "../envelope/payloadSchema.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { parseModelField } from "./modelField.js";
import {
  allowLegacyYamlAuthoring,
  dialectWarningForDocument,
  legacyAuthoringRejected,
  presentLegacyKeys,
} from "./legacyYaml.js";
import { parsePreEmitChecks } from "./parsePreEmitChecks.js";
import { readYamlObject } from "./readYamlObject.js";
import {
  applyCompiledBody,
  classifyYamlDocument,
  compileTargetContract,
  dialectFromKeys,
  mixedDialectIssue,
  STAGE_FILE_WIRING_KEYS,
} from "./yamlDialect.js";

const afterCompletionByStage = new WeakMap<StageConfig, CompletionContract>();

/** After-phase IR from target `verify` (`when` includes after). Stamped onto DAG `completion`. */
export function afterCompletionForStage(stage: StageConfig): CompletionContract | undefined {
  return afterCompletionByStage.get(stage);
}

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

export function parseStageMcp(
  raw: unknown,
  label: string,
  stageId?: string,
): LoadOutcome<string[] | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!Array.isArray(raw)) {
    return loadFailure([
      {
        code: "stage.invalid_mcp",
        message: `Invalid stage ${label}: mcp must be an array of server names`,
        category: "stage",
        stageId,
      },
    ]);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      return loadFailure([
        {
          code: "stage.invalid_mcp",
          message: `Invalid stage ${label}: mcp entries must be strings`,
          category: "stage",
          stageId,
        },
      ]);
    }
    const name = item.trim();
    if (name === "") {
      return loadFailure([
        {
          code: "stage.invalid_mcp",
          message: `Invalid stage ${label}: mcp entries must be non-empty strings`,
          category: "stage",
          stageId,
        },
      ]);
    }
    if (name === STAGEFLOW_MCP_SERVER_NAME) {
      return loadFailure([
        {
          code: "stage.invalid_mcp",
          message: `Invalid stage ${label}: mcp must not include reserved name "${STAGEFLOW_MCP_SERVER_NAME}"`,
          category: "stage",
          stageId,
        },
      ]);
    }
    if (seen.has(name)) {
      return loadFailure([
        {
          code: "stage.invalid_mcp",
          message: `Invalid stage ${label}: mcp contains duplicate name "${name}"`,
          category: "stage",
          stageId,
        },
      ]);
    }
    seen.add(name);
    names.push(name);
  }
  return loadSuccess(names);
}

function parseStageFields(
  raw: Record<string, unknown>,
  label: string,
  entryId: string,
  deferSchemaRefs: boolean,
): LoadOutcome<StageConfig> {
  // Reads IR field names. Target YAML must already be compiled via
  // applyCompiledBody; legacy YAML uses these keys as authoring.
  if (typeof raw.system_prompt !== "string") {
    return loadFailure([
      {
        code: "stage.invalid_shape",
        message: `Invalid stage ${label}: system_prompt is a required string`,
        category: "stage",
        stageId: entryId,
      },
    ]);
  }

  const stage: StageConfig = {
    id: entryId,
    system_prompt: raw.system_prompt,
  };

  const modelField = parseModelField(raw.model);
  if (!modelField.ok) {
    return loadFailure([
      {
        code: "stage.invalid_model",
        message: `Invalid stage ${label}: ${modelField.message}`,
        category: "stage",
        stageId: entryId,
      },
    ]);
  }
  if (modelField.value !== undefined) {
    stage.model = modelField.value;
  }

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
      if (err instanceof UnresolvedSchemaRefError) {
        if (!deferSchemaRefs) {
          return loadFailure([
            {
              code: "stage.unresolved_schema_ref",
              message: `Invalid stage ${label}: ${err.message}`,
              category: "stage",
              stageId: entryId,
            },
          ]);
        }
      } else {
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
      if (err instanceof UnresolvedSchemaRefError) {
        if (!deferSchemaRefs) {
          return loadFailure([
            {
              code: "stage.unresolved_schema_ref",
              message: `Invalid stage ${label}: ${err.message}`,
              category: "stage",
              stageId: entryId,
            },
          ]);
        }
      } else {
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

  const mcpOutcome = parseStageMcp(raw.mcp, label, entryId);
  if (!mcpOutcome.ok) return mcpOutcome;
  if (mcpOutcome.value !== undefined) {
    stage.mcp = mcpOutcome.value;
  }

  const agentField = parseAgentField(raw.agent);
  if (!agentField.ok) {
    return loadFailure([
      {
        code: "stage.invalid_agent",
        message: `Invalid stage ${label}: ${agentField.message}`,
        category: "stage",
        stageId: entryId,
      },
    ]);
  }
  if (agentField.value !== undefined) {
    stage.agent = agentField.value;
  }

  return loadSuccess(stage);
}

export type LoadStageOptions = {
  deferSchemaRefs?: boolean;
};

export function loadStageFromObjectOutcome(
  raw: Record<string, unknown>,
  ctx: { entryId: string; declaringPath: string; deferSchemaRefs?: boolean },
): LoadOutcome<StageConfig> {
  const label = `${ctx.entryId} (${ctx.declaringPath})`;
  const deferSchemaRefs = ctx.deferSchemaRefs === true;
  const dialect = dialectFromKeys(Object.keys(raw));
  if (dialect === "invalid") {
    return loadFailure([mixedDialectIssue()]);
  }
  const rejected = legacyAuthoringRejected(
    dialect,
    label,
    presentLegacyKeys(Object.keys(raw)),
  );
  if (rejected) return loadFailure([rejected]);
  if (dialect === "target") {
    const compiled = compileTargetContract(raw, {
      stageId: ctx.entryId,
      label,
      category: "stage",
      deferSchemaRefs,
    });
    if (!compiled.ok) return compiled;
    return parseStageFields(
      applyCompiledBody(raw, compiled.value),
      label,
      ctx.entryId,
      deferSchemaRefs,
    );
  }
  return parseStageFields(raw, label, ctx.entryId, deferSchemaRefs);
}

export async function loadStageOutcome(
  filePath: string,
  options: LoadStageOptions = {},
): Promise<LoadOutcome<StageConfig>> {
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
        message: `Invalid stage file ${filePath}: id and system_prompt are required strings`,
        category: "stage",
      },
    ]);
  }

  const dialect = classifyYamlDocument(raw);
  if (dialect === "invalid") {
    return loadFailure([mixedDialectIssue()]);
  }
  const rejected = legacyAuthoringRejected(
    dialect,
    filePath,
    presentLegacyKeys(Object.keys(raw)),
  );
  if (rejected) return loadFailure([rejected]);
  if (dialect === "target") {
    const wiring = STAGE_FILE_WIRING_KEYS.find((key) => raw[key] !== undefined);
    if (wiring) {
      return loadFailure([
        {
          code: "stage.invalid_shape",
          message: `Invalid stage file ${filePath}: new-dialect stage files must not declare wiring key "${wiring}"`,
          category: "stage",
          stageId: raw.id,
        },
      ]);
    }
  }

  let parseRaw = raw;
  let afterCompletion: CompletionContract | undefined;
  const deferSchemaRefs = options.deferSchemaRefs === true;
  if (dialect === "target") {
    const compiled = compileTargetContract(raw, {
      stageId: raw.id,
      label: `file ${filePath}`,
      category: "stage",
      deferSchemaRefs,
    });
    if (!compiled.ok) return compiled;
    parseRaw = applyCompiledBody(raw, compiled.value);
    afterCompletion = compiled.value.completion;
  }

  const outcome = parseStageFields(parseRaw, `file ${filePath}`, raw.id, deferSchemaRefs);
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

  if (afterCompletion) afterCompletionByStage.set(outcome.value, afterCompletion);
  const warning = allowLegacyYamlAuthoring()
    ? dialectWarningForDocument(raw, filePath)
    : undefined;
  return loadSuccess(outcome.value, warning ? [warning] : undefined);
}

export async function loadStage(filePath: string): Promise<StageConfig> {
  const outcome = await loadStageOutcome(filePath);
  if (!outcome.ok) {
    throw new Error(outcome.issues[0].message);
  }
  return outcome.value;
}
