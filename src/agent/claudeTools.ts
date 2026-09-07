/**
 * Claude Agent SDK tool wrappers for the stage tool set.
 *
 * The actual envelope/artifact business logic lives in
 * `tools/emitStageEnvelope.ts` / `tools/writeStageArtifact.ts` and is fully
 * SDK-agnostic (typed `params: unknown`, no Pi imports) — this file reuses
 * those `execute` functions as-is and only translates the *declaration*
 * layer (typebox → Zod) and the *result* layer (drops Pi-only `terminate`/
 * `details` fields, keeping just the MCP `CallToolResult` shape).
 *
 * `ask_operator` is different: `tools/askOperator.ts`'s own `execute` blocks
 * on an injected wait bridge (Pi's in-process mechanism), which is exactly
 * what Phase 3's "never let it go dangling" design avoids. This file reuses
 * only the pure parsing/validation helpers from that module
 * (`parseAskOperatorParams`, `normalizePromptIds`) and writes its own
 * non-blocking handler: record the prompt on `capture`, return an immediate
 * placeholder result, and rely on the adapter's `interrupt()` backstop
 * (called right after this result lands) to end the turn — see
 * claudeAdapter.ts.
 *
 * Registered under one in-process MCP server named "stageflow", so the model
 * sees these as `mcp__stageflow__emit_stage_envelope`,
 * `mcp__stageflow__write_stage_artifact`, and `mcp__stageflow__ask_operator`
 * — those exact strings are what `composeStageUserPrompt`'s hints and the
 * adapter's resume prompts must reference.
 */
import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createEmitStageEnvelopeTool,
  type EmitCapture,
} from "../tools/emitStageEnvelope.js";
import {
  createWriteStageArtifactTool,
  type WriteStageArtifactOptions,
} from "../tools/writeStageArtifact.js";
import {
  ASK_OPERATOR_KINDS,
  AskOperatorError,
  normalizePromptIds,
  parseAskOperatorParams,
  type AskOperatorKind,
  type AskOperatorPrompt,
} from "../tools/askOperator.js";
import type { CloneEmitContext, ForkEmitContext } from "../types/forkChoice.js";
import type { PreEmitCheckOptions } from "../envelope/preEmitChecks.js";

export const STAGEFLOW_MCP_SERVER_NAME = "stageflow";
export const EMIT_STAGE_ENVELOPE_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__emit_stage_envelope`;
export const WRITE_STAGE_ARTIFACT_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__write_stage_artifact`;
export const ASK_OPERATOR_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__ask_operator`;

export type AskOperatorCapture = { prompt?: AskOperatorPrompt };

/**
 * Exported so a parity test can assert this stays field-for-field aligned
 * with `tools/emitStageEnvelope.ts`'s typebox schema — the two are hand
 * written against the same envelope shape with no shared source, so
 * nothing else catches one drifting from the other.
 *
 * Field presence mirrors the typebox schema's own conditionality:
 * `clone_forks` only exists when a stage can clone-fork at all, and
 * `fork_choice` is required (not just present) when the stage has a fork
 * to route. Building this statically would silently offer the model a
 * `clone_forks` field on stages that have nowhere to route one.
 */
export function buildEmitStageEnvelopeShape(options: {
  forkEmitContext?: ForkEmitContext;
  cloneEmitContext?: CloneEmitContext;
}) {
  return {
    status: z.enum(["success", "failure"]),
    summary: z.string().min(1),
    artifacts: z.array(z.string()),
    payload: z.record(z.string(), z.unknown()).optional(),
    fork_choice:
      options.forkEmitContext !== undefined
        ? z.array(z.string())
        : z.array(z.string()).optional(),
    ...(options.cloneEmitContext !== undefined
      ? { clone_forks: z.array(z.record(z.string(), z.unknown())) }
      : {}),
    checklist_attestations: z
      .array(
        z.object({
          check_id: z.string().min(1),
          items: z.array(z.string()),
        }),
      )
      .optional(),
    stage_id: z.string().optional(),
    notes: z.string().optional(),
  };
}

/** Exported for the same parity-test reason as `emitStageEnvelopeShape` above. */
export const writeStageArtifactShape = {
  path: z.string().min(1),
  content: z.string(),
};

const askOperatorShape = {
  kind: z.string(),
  message: z.string().optional(),
  id: z.string().optional(),
  questions: z.array(z.record(z.string(), z.unknown())).optional(),
  artifacts: z.array(z.string()).optional(),
};

/** Adapts a `{content, details?, isError?, terminate?}` tool result to plain MCP CallToolResult. */
function toCallToolResult(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}) {
  return {
    content: result.content,
    ...(result.isError ? { isError: true } : {}),
  };
}

function buildAskOperatorTool(
  capture: AskOperatorCapture,
  allowedKinds?: readonly AskOperatorKind[],
) {
  const allowed =
    allowedKinds && allowedKinds.length > 0
      ? new Set<AskOperatorKind>(allowedKinds)
      : null;
  const kindList = allowed ? [...allowed].join(", ") : ASK_OPERATOR_KINDS.join(", ");

  return tool(
    "ask_operator",
    `Ask the operator a question and stop. Supports ${kindList} prompts. Calling this tool immediately ends your turn — after it returns, do not call any more tools and do not keep talking; you will be resumed in a new turn once the operator has answered. Does not complete the stage — call emit_stage_envelope when finished.`,
    askOperatorShape,
    async (args) => {
      try {
        const parsed = parseAskOperatorParams(args);
        if (allowed && !allowed.has(parsed.kind)) {
          throw new AskOperatorError(
            `unsupported prompt kind "${parsed.kind}" (allowed: ${kindList})`,
          );
        }
        capture.prompt = normalizePromptIds(parsed);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Invalid ask_operator params: ${message}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "Question recorded for the operator. Stop here — do not call any more tools or continue this turn; you will be resumed with the operator's answer in a new turn.",
          },
        ],
      };
    },
  );
}

export function buildStageflowMcpServer(options: {
  capture: EmitCapture;
  payloadSchema?: unknown;
  forkEmitContext?: ForkEmitContext;
  cloneEmitContext?: CloneEmitContext;
  preEmitCheckOptions?: PreEmitCheckOptions;
  writeStageArtifact: WriteStageArtifactOptions;
  askOperator?: {
    capture: AskOperatorCapture;
    allowedKinds?: readonly AskOperatorKind[];
  };
}): McpServerConfig {
  const emitDef = createEmitStageEnvelopeTool(
    options.capture,
    options.payloadSchema,
    options.forkEmitContext,
    options.cloneEmitContext,
    options.preEmitCheckOptions,
  );
  const artifactDef = createWriteStageArtifactTool(options.writeStageArtifact);

  const emitTool = tool(
    emitDef.name,
    emitDef.description,
    buildEmitStageEnvelopeShape({
      forkEmitContext: options.forkEmitContext,
      cloneEmitContext: options.cloneEmitContext,
    }),
    async (args) => toCallToolResult(await emitDef.execute("claude-tool-call", args)),
  );

  const artifactTool = tool(
    artifactDef.name,
    artifactDef.description,
    writeStageArtifactShape,
    async (args) =>
      toCallToolResult(await artifactDef.execute("claude-tool-call", args)),
  );

  const tools: Array<SdkMcpToolDefinition<any>> = [emitTool, artifactTool];
  if (options.askOperator) {
    tools.push(
      buildAskOperatorTool(options.askOperator.capture, options.askOperator.allowedKinds),
    );
  }

  return createSdkMcpServer({
    name: STAGEFLOW_MCP_SERVER_NAME,
    tools,
  });
}
