/**
 * Host-owned tool output budget for sealed stage sessions. Each non-exempt
 * tool result is measured against the remaining context window; a result that
 * does not fit is written to the stage attempt's artifacts directory and the
 * model sees a path, size, and short preview instead.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  buildPreview,
  decideToolOutput,
  estimateTokens,
  IMAGE_BLOCK_EST_TOKENS,
  truncateUtf8,
  UNKNOWN_USAGE_INLINE_MAX_BYTES,
  utf8ByteLength,
  type BudgetDecision,
  type SpillReason,
} from "./toolOutputBudget.js";
import { spillToolOutput, type SpilledToolOutput } from "./toolOutputSpill.js";
import { discardAdapterSpill, readAdapterSpill } from "./adapterSpill.js";

export const STAGEFLOW_TOOL_OUTPUT_EXTENSION_NAME = "stageflow-tool-output";

export type ToolOutputSpillEvent = {
  toolName: string;
  toolCallId: string;
  reason: SpillReason;
  originalBytes: number;
  estTokens: number;
  runRelativePath?: string;
  error?: string;
};

export type ToolOutputBudgetOptions = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
  exempt: ReadonlySet<string>;
  onSpill?: (event: ToolOutputSpillEvent) => void;
};

type ContentBlock = TextContent | ImageContent;

export function formatSpillNotice(
  spilled: SpilledToolOutput,
  estTokens: number,
  lostReason?: string,
): string {
  return [
    `[Tool output saved as stage artifact: ${spilled.runRelativePath}`,
    ` Read path: ${spilled.absolutePath}`,
    ` Size: ${spilled.bytes} bytes, ${spilled.lines} lines (~${estTokens} tokens). Too large to include inline.`,
    lostReason !== undefined
      ? ` The MCP adapter cut this output and the rest is not available (${lostReason}). This file holds only what was returned.`
      : undefined,
    spilled.wrapped
      ? ` Long lines were wrapped at 4 KiB so the file can be paged; the breaks are not part of the data.`
      : undefined,
    spilled.hasLongLines
      ? ` Some JSON lines are long string values; page them with bash (jq, cut -c) rather than read.`
      : undefined,
    ` It is already a stage artifact: read it with \`read\` (offset/limit) or grep it, and list`,
    ` this path in the envelope artifacts if the stage output depends on it. Do not copy it.]`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function joinText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function createToolOutputBudgetExtension(
  options: ToolOutputBudgetOptions,
): ExtensionFactory {
  return (pi) => {
    let turnLedgerTokens = 0;

    pi.on("message_end", async (event) => {
      if (event.message.role === "assistant") {
        turnLedgerTokens = 0;
      }
      return undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
      if (options.exempt.has(event.toolName)) return undefined;
      if (event.parentToolCallId !== undefined) return undefined;

      const images = event.content.filter(
        (block): block is ImageContent => block.type === "image",
      );
      turnLedgerTokens += images.length * IMAGE_BLOCK_EST_TOKENS;
      const visible = joinText(event.content);
      // A result the MCP adapter already cut is incomplete inline: always spill
      // it, from the adapter's full-output file when that file checks out.
      const adapterSpill = await readAdapterSpill(visible, event.details);
      const text = adapterSpill.kind === "full" ? adapterSpill.text : visible;
      const resultBytes = utf8ByteLength(text);
      const usage = ctx.getContextUsage();
      const decision: BudgetDecision =
        adapterSpill.kind === "none"
          ? decideToolOutput({
              resultBytes,
              contextWindow: usage?.contextWindow ?? 0,
              knownTokens: usage?.tokens ?? null,
              turnLedgerTokens,
            })
          : { kind: "spill", estTokens: estimateTokens(resultBytes), reason: "adapter_truncated" };

      if (decision.kind === "inline") {
        turnLedgerTokens += decision.estTokens;
        return undefined;
      }

      let replacement: string;
      let spillDetails: Record<string, unknown>;
      let fullOutputPath: string | undefined;
      try {
        const spilled = await spillToolOutput({
          runWorkspaceDir: options.runWorkspaceDir,
          stageId: options.stageId,
          attempt: options.attempt,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          text,
        });
        if (adapterSpill.kind === "full") {
          await discardAdapterSpill(adapterSpill.sourcePath);
          fullOutputPath = spilled.absolutePath;
        }
        const notice = formatSpillNotice(
          spilled,
          decision.estTokens,
          adapterSpill.kind === "lost" ? adapterSpill.reason : undefined,
        );
        replacement = `${notice}\n\n${buildPreview(spilled.body, spilled.json !== undefined ? { json: spilled.json } : {})}`;
        spillDetails = {
          spilled: true,
          path: spilled.runRelativePath,
          bytes: spilled.bytes,
          lines: spilled.lines,
          originalBytes: resultBytes,
          estTokens: decision.estTokens,
          reason: decision.reason,
          ...(adapterSpill.kind === "lost" ? { incomplete: true } : {}),
        };
        options.onSpill?.({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          reason: decision.reason,
          originalBytes: resultBytes,
          estTokens: decision.estTokens,
          runRelativePath: spilled.runRelativePath,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        replacement = `${truncateUtf8(text, UNKNOWN_USAGE_INLINE_MAX_BYTES)}\n\n[Tool output truncated: original ${resultBytes} bytes. Saving the full output as a stage artifact failed: ${message}]`;
        spillDetails = {
          spilled: false,
          originalBytes: resultBytes,
          estTokens: decision.estTokens,
          reason: decision.reason,
          error: message,
        };
        options.onSpill?.({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          reason: decision.reason,
          originalBytes: resultBytes,
          estTokens: decision.estTokens,
          error: message,
        });
      }

      turnLedgerTokens += estimateTokens(utf8ByteLength(replacement));
      const previousDetails =
        event.details !== null && typeof event.details === "object"
          ? (event.details as Record<string, unknown>)
          : {};
      const outputGuard = previousDetails.outputGuard;
      return {
        content: [{ type: "text" as const, text: replacement }, ...images],
        details: {
          ...previousDetails,
          ...(fullOutputPath !== undefined &&
          outputGuard !== null &&
          typeof outputGuard === "object"
            ? { outputGuard: { ...outputGuard, fullOutputPath } }
            : {}),
          stageflowToolOutput: spillDetails,
        },
      };
    });
  };
}
