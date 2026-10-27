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
import type { FeedbackLoopConfig } from "../types/pipeline.js";
import type { PreEmitCheckOptions } from "../envelope/preEmitChecks.js";
import { execInSandboxContainer as defaultExecInSandboxContainer } from "../runtime/sandboxContainer.js";
import {
  editSandboxFile,
  formatSandboxBashResult,
  readSandboxFile,
  sliceSandboxLines,
  writeSandboxFile,
} from "../runtime/sandboxFiles.js";

export const STAGEFLOW_MCP_SERVER_NAME = "stageflow";
export const EMIT_STAGE_ENVELOPE_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__emit_stage_envelope`;
export const WRITE_STAGE_ARTIFACT_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__write_stage_artifact`;
export const ASK_OPERATOR_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__ask_operator`;
export const SANDBOX_BASH_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__sandbox_bash`;
export const SANDBOX_READ_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__sandbox_read`;
export const SANDBOX_WRITE_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__sandbox_write`;
export const SANDBOX_EDIT_TOOL_NAME = `mcp__${STAGEFLOW_MCP_SERVER_NAME}__sandbox_edit`;

export type AskOperatorCapture = { prompt?: AskOperatorPrompt };

/**
 * Exported so a parity test can assert this stays field-for-field aligned
 * with `tools/emitStageEnvelope.ts`'s typebox schema — the two are hand
 * written against the same envelope shape with no shared source, so
 * nothing else catches one drifting from the other.
 *
 * Field presence mirrors the typebox schema's own conditionality:
 * `fork_choice` is required (not just present) when the stage has a fork
 * to route.
 */
function feedbackLoopShape(context: FeedbackLoopConfig) {
  return z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("continue") }),
    z.strictObject({
      action: z.literal("send_back"),
      target: z.literal(context.target),
    }),
  ]);
}

function payloadShape(payloadSchema: unknown | undefined, required: boolean) {
  const base =
    payloadSchema === undefined
      ? z.record(z.string(), z.unknown())
      : z.fromJSONSchema(payloadSchema as Parameters<typeof z.fromJSONSchema>[0]);
  return required ? base : base.optional();
}

export function buildEmitStageEnvelopeShape(options: {
  forkEmitContext?: ForkEmitContext;
  cloneEmitContext?: CloneEmitContext;
  payloadSchema?: unknown;
  feedbackLoopEmitContext?: FeedbackLoopConfig;
}) {
  const forkRequired =
    options.forkEmitContext !== undefined && options.feedbackLoopEmitContext === undefined;
  const attestations = z
    .array(
      z.strictObject({
        check_id: z.string().min(1),
        items: z.array(z.string()),
      }),
    )
    .optional();
  const shared = {
    summary: z.string().min(1),
    artifacts: z.array(z.string()),
    checklist_attestations: attestations,
    stage_id: z.string().optional(),
    notes: z.string().optional(),
    fork_choice: z.array(z.string()).optional(),
  };
  return z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("success"),
      ...shared,
      payload: payloadShape(options.payloadSchema, options.payloadSchema !== undefined),
      fork_choice: forkRequired ? z.array(z.string()) : z.array(z.string()).optional(),
      ...(options.feedbackLoopEmitContext !== undefined
        ? { feedback_loop: feedbackLoopShape(options.feedbackLoopEmitContext) }
        : {}),
    }),
    z.strictObject({
      status: z.literal("failure"),
      ...shared,
      payload: payloadShape(options.payloadSchema, false),
    }),
  ]);
}

function asClaudeObjectSchema(schema: z.ZodType): z.ZodType {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  const target = schema as z.ZodType & {
    _zod: { def: { type?: string }; toJSONSchema?: () => unknown };
  };
  target._zod.def.type = "object";
  target._zod.toJSONSchema = () => json;
  return schema;
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

const sandboxBashShape = {
  command: z.string().min(1),
};

type SandboxExecFn = typeof defaultExecInSandboxContainer;

export type SandboxBashOptions = {
  containerName: string;
  dockerBin?: string;
  execute?: SandboxExecFn;
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

/**
 * When a sandbox container is set, Read/Write/Edit/Bash are aliased onto
 * these tools. They run against the attempt desk at /workspace. Other stage
 * tools stay on the host.
 */
function buildSandboxBashTool(options: SandboxBashOptions) {
  const execute = options.execute ?? defaultExecInSandboxContainer;
  return tool(
    "sandbox_bash",
    "Run a shell command inside this stage attempt's sandbox. The working directory is /workspace. The host filesystem is not mounted.",
    sandboxBashShape,
    async (args) => {
      let result;
      try {
        result = await execute({
          containerName: options.containerName,
          command: args.command,
          dockerBin: options.dockerBin,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `sandbox_bash could not run: ${message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatSandboxBashResult(result) }],
      };
    },
  );
}

const sandboxReadShape = {
  file_path: z.string().min(1),
  offset: z.number().optional(),
  limit: z.number().optional(),
};

const sandboxWriteShape = {
  file_path: z.string().min(1),
  content: z.string(),
};

const sandboxEditShape = {
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
};

function sandboxFileError(err: unknown, label: string) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `${label} could not run: ${message}` }],
    isError: true,
  };
}

function buildSandboxReadTool(options: SandboxBashOptions) {
  return tool(
    "sandbox_read",
    "Read a file inside this stage attempt's sandbox. Paths are relative to /workspace or absolute under /workspace. Host paths are rejected.",
    sandboxReadShape,
    async (args) => {
      try {
        const text = await readSandboxFile(options, args.file_path);
        return {
          content: [{ type: "text" as const, text: sliceSandboxLines(text, args.offset, args.limit) }],
        };
      } catch (err) {
        return sandboxFileError(err, "sandbox_read");
      }
    },
  );
}

function buildSandboxWriteTool(options: SandboxBashOptions) {
  return tool(
    "sandbox_write",
    "Write a file inside this stage attempt's sandbox. Paths are relative to /workspace or absolute under /workspace. Host paths are rejected.",
    sandboxWriteShape,
    async (args) => {
      try {
        await writeSandboxFile(options, args.file_path, args.content);
        return { content: [{ type: "text" as const, text: `Successfully wrote to ${args.file_path}` }] };
      } catch (err) {
        return sandboxFileError(err, "sandbox_write");
      }
    },
  );
}

function buildSandboxEditTool(options: SandboxBashOptions) {
  return tool(
    "sandbox_edit",
    "Edit a file inside this stage attempt's sandbox. old_string must match exactly once. Paths stay under /workspace.",
    sandboxEditShape,
    async (args) => {
      try {
        await editSandboxFile(options, args.file_path, [
          { oldText: args.old_string, newText: args.new_string },
        ]);
        return { content: [{ type: "text" as const, text: `Successfully edited ${args.file_path}` }] };
      } catch (err) {
        return sandboxFileError(err, "sandbox_edit");
      }
    },
  );
}

export function buildStageflowMcpServer(options: {
  capture: EmitCapture;
  payloadSchema?: unknown;
  forkEmitContext?: ForkEmitContext;
  cloneEmitContext?: CloneEmitContext;
  preEmitCheckOptions?: PreEmitCheckOptions;
  feedbackLoopEmitContext?: FeedbackLoopConfig;
  writeStageArtifact: WriteStageArtifactOptions;
  askOperator?: {
    capture: AskOperatorCapture;
    allowedKinds?: readonly AskOperatorKind[];
  };
  sandboxBash?: SandboxBashOptions;
}): McpServerConfig {
  const emitDef = createEmitStageEnvelopeTool(
    options.capture,
    options.payloadSchema,
    options.forkEmitContext,
    options.cloneEmitContext,
    options.preEmitCheckOptions,
    options.feedbackLoopEmitContext,
  );
  const artifactDef = createWriteStageArtifactTool(options.writeStageArtifact);

  const emitTool = tool(
    emitDef.name,
    emitDef.description,
    asClaudeObjectSchema(
      buildEmitStageEnvelopeShape({
        forkEmitContext: options.forkEmitContext,
        cloneEmitContext: options.cloneEmitContext,
        payloadSchema: options.payloadSchema,
        feedbackLoopEmitContext: options.feedbackLoopEmitContext,
      }),
    ) as never,
    async (args) => toCallToolResult(await emitDef.execute("claude-tool-call", args)),
  ) as unknown as SdkMcpToolDefinition<any>;

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
  if (options.sandboxBash) {
    tools.push(
      buildSandboxReadTool(options.sandboxBash),
      buildSandboxWriteTool(options.sandboxBash),
      buildSandboxEditTool(options.sandboxBash),
      buildSandboxBashTool(options.sandboxBash),
    );
  }

  return createSdkMcpServer({
    name: STAGEFLOW_MCP_SERVER_NAME,
    tools,
  });
}
