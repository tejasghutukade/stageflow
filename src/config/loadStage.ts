import { parseChannels } from "../channels/stageChannels.js";
import { parseAgentField } from "../agent/agentBackend.js";
import { STAGEFLOW_MCP_SERVER_NAME } from "../agent/claudeTools.js";
import type { CompletionContract } from "../types/completion.js";
import {
  STAGE_GATE_KINDS,
  type StageConfig,
  type StageMcpTools,
  type StageGateKind,
} from "../types/stage.js";
import { compilePayloadSchema, UnresolvedSchemaRefError } from "../envelope/payloadSchema.js";
import { parseStageFunctionTools } from "./loadFunction.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { parseIndependenceField } from "./independenceField.js";
import { parseModelField } from "./modelField.js";
import {
  allowLegacyYamlAuthoring,
  dialectWarningForDocument,
  legacyAuthoringRejected,
  presentLegacyKeys,
} from "./legacyYaml.js";
import { parsePreEmitChecks } from "./parsePreEmitChecks.js";
import { readYamlObject } from "./readYamlObject.js";
import { yamlParsePosition } from "./yamlParsePosition.js";
import { z } from "zod";
import { parseStageSecrets } from "../runtime/stageSecretDecl.js";
import { parseToolRequires } from "./toolRequires.js";
import { parseStageBrowser } from "./stageBrowser.js";
import {
  classifyYamlDocument,
  compileTargetContract,
  dialectFromKeys,
  mixedDialectIssue,
  STAGE_FILE_WIRING_KEYS,
  type CompiledTargetContract,
} from "./yamlDialect.js";

const afterCompletionByStage = new WeakMap<StageConfig, CompletionContract>();

/** After-phase IR from target `verify` (`when` includes after). Stamped onto DAG `completion`. */
export function afterCompletionForStage(stage: StageConfig): CompletionContract | undefined {
  return afterCompletionByStage.get(stage);
}

function isGateKind(value: string): value is StageGateKind {
  return (STAGE_GATE_KINDS as readonly string[]).includes(value);
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

function mcpIssue(label: string, message: string, stageId?: string): LoadOutcome<never> {
  return loadFailure([
    {
      code: "stage.invalid_mcp",
      message: `Invalid stage ${label}: ${message}`,
      category: "stage",
      stageId,
    },
  ]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function takeServerName(
  raw: string,
  label: string,
  stageId: string | undefined,
  seen: Set<string>,
): LoadOutcome<string> {
  const name = raw.trim();
  if (name === "") {
    return mcpIssue(label, "mcp entries must be non-empty strings", stageId);
  }
  if (name === STAGEFLOW_MCP_SERVER_NAME) {
    return mcpIssue(
      label,
      `mcp must not include reserved name "${STAGEFLOW_MCP_SERVER_NAME}"`,
      stageId,
    );
  }
  if (seen.has(name)) {
    return mcpIssue(label, `mcp contains duplicate name "${name}"`, stageId);
  }
  seen.add(name);
  return loadSuccess(name);
}

function parseToolList(
  raw: unknown,
  server: string,
  label: string,
  stageId?: string,
): LoadOutcome<"*" | string[]> {
  if (!Array.isArray(raw)) {
    return mcpIssue(label, `mcp tool list for "${server}" must be an array of tool names`, stageId);
  }
  if (raw.length === 0) {
    return mcpIssue(label, `mcp tool list for "${server}" must name at least one tool`, stageId);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      return mcpIssue(label, `mcp tool list for "${server}" entries must be strings`, stageId);
    }
    const name = item.trim();
    if (name === "") {
      return mcpIssue(label, `mcp tool list for "${server}" entries must be non-empty strings`, stageId);
    }
    if (seen.has(name)) {
      return mcpIssue(
        label,
        `mcp tool list for "${server}" contains duplicate name "${name}"`,
        stageId,
      );
    }
    seen.add(name);
    names.push(name);
  }
  if (names.includes("*") && names.length !== 1) {
    return mcpIssue(
      label,
      `mcp tool list for "${server}" must be tool names or a single "*"`,
      stageId,
    );
  }
  if (names.length === 1 && names[0] === "*") return loadSuccess("*");
  return loadSuccess(names);
}

export type ParsedStageMcp = {
  servers: string[];
  tools?: StageMcpTools;
};

function parseStageMcpNames(
  raw: unknown[],
  label: string,
  stageId?: string,
): LoadOutcome<ParsedStageMcp> {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      return mcpIssue(label, "mcp entries must be strings", stageId);
    }
    const name = takeServerName(item, label, stageId, seen);
    if (!name.ok) return name;
    names.push(name.value);
  }
  return loadSuccess({ servers: names });
}

function parseStageMcpMap(
  raw: Record<string, unknown>,
  label: string,
  stageId?: string,
): LoadOutcome<ParsedStageMcp> {
  const servers: string[] = [];
  const seen = new Set<string>();
  const tools: Record<string, readonly string[]> = {};
  let named = false;
  for (const key of Object.keys(raw)) {
    const server = takeServerName(key, label, stageId, seen);
    if (!server.ok) return server;
    const list = parseToolList(raw[key], server.value, label, stageId);
    if (!list.ok) return list;
    servers.push(server.value);
    if (list.value === "*") {
      tools[server.value] = ["*"];
    } else {
      named = true;
      tools[server.value] = list.value;
    }
  }
  if (!named) return loadSuccess({ servers });
  return loadSuccess({ servers, tools });
}

export function parseStageMcp(
  raw: unknown,
  label: string,
  stageId?: string,
): LoadOutcome<ParsedStageMcp | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (Array.isArray(raw)) return parseStageMcpNames(raw, label, stageId);
  if (isPlainObject(raw)) return parseStageMcpMap(raw, label, stageId);
  return mcpIssue(
    label,
    "mcp must be a list of server names or a map of server names to tool names",
    stageId,
  );
}

function parseStageFields(
  raw: Record<string, unknown>,
  label: string,
  entryId: string,
  deferSchemaRefs: boolean,
  requireIo: boolean,
  compiled?: CompiledTargetContract,
): LoadOutcome<StageConfig> {
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
  if (raw.email !== undefined) {
    const permissions = z.array(z.object({ accountId: z.string().min(1).max(200),
      operations: z.array(z.enum(["send", "reply", "getMessage", "search", "downloadAttachment"])).min(1).max(5),
    }).strict()).max(20).safeParse(raw.email);
    if (!permissions.success || new Set(permissions.data.map(permission => permission.accountId)).size !== permissions.data.length) {
      return loadFailure([{ code: "stage.invalid_shape", message: `Invalid stage ${label}: invalid email permissions`, category: "stage", stageId: entryId }]);
    }
    stage.email = permissions.data;
  }

  if (raw.clone_actions !== undefined) {
    return loadFailure([
      {
        code: "stage.invalid_clone_actions",
        message: `Invalid stage ${label}: "clone_actions" is no longer supported — use a Clone Chain instead`,
        category: "stage",
        stageId: entryId,
      },
    ]);
  }

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

  const independenceField = parseIndependenceField(raw.independence);
  if (!independenceField.ok) {
    return loadFailure([
      {
        code: "stage.invalid_independence",
        message: `Invalid stage ${label}: ${independenceField.message}`,
        category: "stage",
        stageId: entryId,
      },
    ]);
  }
  if (independenceField.value !== undefined) {
    stage.independence = independenceField.value;
  }

  if (raw.checkout_context !== undefined && typeof raw.checkout_context !== "boolean") {
    return loadFailure([
      {
        code: "stage.invalid_checkout_context",
        message: `Invalid stage ${label}: checkout_context must be a boolean`,
        category: "stage",
        stageId: entryId,
      },
    ]);
  }
  if (raw.checkout_context === true) {
    stage.checkout_context = true;
  }

  if (compiled) {
    if (compiled.payload_schema !== undefined) {
      stage.payload_schema = compiled.payload_schema;
    }
    if (compiled.clone_input_schema !== undefined) {
      stage.clone_input_schema = compiled.clone_input_schema;
    }
  } else {
    if (raw.payload_schema !== undefined) {
      if (
        raw.payload_schema === null ||
        typeof raw.payload_schema !== "object" ||
        Array.isArray(raw.payload_schema)
      ) {
          return loadFailure([
            {
              code: "stage.invalid_payload_schema",
              message: `Invalid stage ${label}: io.output.schema must be an object`,
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
              message: `Invalid stage ${label}: invalid io.output.schema: ${message}`,
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
              message: `Invalid stage ${label}: io.input.schema must be an object`,
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
              message: `Invalid stage ${label}: invalid io.input.schema: ${message}`,
              category: "stage",
              stageId: entryId,
            },
          ]);
        }
      }
      stage.clone_input_schema = raw.clone_input_schema;
    }

    if (requireIo) {
      if (raw.payload_schema === undefined && raw.clone_input_schema === undefined) {
        return loadFailure([
          {
            code: "stage.invalid_io",
            message: `Invalid stage ${label}: io is required`,
            category: "stage",
            stageId: entryId,
          },
        ]);
      }
      if (raw.payload_schema === undefined) {
        return loadFailure([
          {
            code: "stage.invalid_io",
            message: `Invalid stage ${label}: io.output.schema is required`,
            category: "stage",
            stageId: entryId,
          },
        ]);
      }
      if (raw.clone_input_schema === undefined) {
        return loadFailure([
          {
            code: "stage.invalid_io",
            message: `Invalid stage ${label}: io.input.schema is required`,
            category: "stage",
            stageId: entryId,
          },
        ]);
      }
    }
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

  if (compiled) {
    if (compiled.pre_emit_checks !== undefined) {
      stage.pre_emit_checks = compiled.pre_emit_checks;
    }
  } else {
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
    stage.mcp = mcpOutcome.value.servers;
    if (mcpOutcome.value.tools !== undefined) stage.mcp_tools = mcpOutcome.value.tools;
  }

  if (raw.channels !== undefined) {
    const channels = parseChannels(raw.channels);
    if (!channels.ok) {
      return loadFailure([
        {
          code: "stage.invalid_channels",
          message: `Invalid stage ${label}: ${channels.message}`,
          category: "stage",
          stageId: entryId,
        },
      ]);
    }
    stage.channels = channels.value;
  }

  const secretsOutcome = parseStageSecrets(raw.secrets, label, entryId);
  if (!secretsOutcome.ok) return secretsOutcome;
  if (secretsOutcome.value !== undefined) {
    stage.secrets = secretsOutcome.value;
  }

  const requiresOutcome = parseToolRequires(raw.requires, `stage ${label}`, {
    code: "stage.invalid_requires",
    category: "stage",
    stageId: entryId,
  });
  if (!requiresOutcome.ok) return requiresOutcome;
  if (requiresOutcome.value !== undefined) {
    stage.requires = requiresOutcome.value;
  }

  const browserOutcome = parseStageBrowser(raw.browser, label, entryId);
  if (!browserOutcome.ok) return browserOutcome;
  if (browserOutcome.value !== undefined) {
    stage.browser = browserOutcome.value;
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

  if (raw.tools !== undefined) {
    const tools = parseStageFunctionTools(raw.tools);
    if (!tools.ok) {
      return loadFailure([
        {
          code: "stage.invalid_shape",
          message: `Invalid stage ${label}: ${tools.message}`,
          category: "stage",
          stageId: entryId,
        },
      ]);
    }
    if (tools.value.functions.length > 0) stage.tools = tools.value;
  }

  return loadSuccess(stage);
}

export type LoadStageOptions = {
  deferSchemaRefs?: boolean;
  requireIo?: boolean;
};

export function loadStageFromObjectOutcome(
  raw: Record<string, unknown>,
  ctx: {
    entryId: string;
    declaringPath: string;
    deferSchemaRefs?: boolean;
    requireIo?: boolean;
  },
): LoadOutcome<StageConfig> {
  const label = `${ctx.entryId} (${ctx.declaringPath})`;
  const deferSchemaRefs = ctx.deferSchemaRefs === true;
  const requireIo = ctx.requireIo !== false;
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
      requireIo,
    });
    if (!compiled.ok) return compiled;
    return parseStageFields(
      raw,
      label,
      ctx.entryId,
      deferSchemaRefs,
      requireIo,
      compiled.value,
    );
  }
  return parseStageFields(raw, label, ctx.entryId, deferSchemaRefs, requireIo);
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
        ...yamlParsePosition(err),
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

  let compiled: CompiledTargetContract | undefined;
  let afterCompletion: CompletionContract | undefined;
  const deferSchemaRefs = options.deferSchemaRefs === true;
  const requireIo = options.requireIo !== false;
  if (dialect === "target") {
    const compiledOutcome = compileTargetContract(raw, {
      stageId: raw.id,
      label: `file ${filePath}`,
      category: "stage",
      deferSchemaRefs,
      requireIo,
    });
    if (!compiledOutcome.ok) return compiledOutcome;
    compiled = compiledOutcome.value;
    afterCompletion = compiled.completion;
  }

  const outcome = parseStageFields(
    raw,
    `file ${filePath}`,
    raw.id,
    deferSchemaRefs,
    requireIo,
    compiled,
  );
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
