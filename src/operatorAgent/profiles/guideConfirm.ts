import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { buildChoicesUi } from "../../guide/cardContract.js";
import {
  confirmFieldsForTool,
  guideConfirmationOutcome,
  guideToolMayNeedConfirmation,
  guideToolRequiresConfirmAction,
  GUIDE_CONFIRMED_TOOLS,
  resolvedModeForCall,
} from "../../toolkit/modePolicy.js";
import type { OperatorAgentTool, OperatorAgentToolContext, OperatorAgentToolResult } from "../types.js";

export { GUIDE_CONFIRMED_TOOLS } from "../../toolkit/modePolicy.js";

export const CONFIRM_ACTION_TOOL = "confirm_action";

const CONFIRMATION_TURNS = 3;

type Confirmation = { id: string; tool: string; summary: string; turn: number; action?: string; confirmId?: string };

export type GuideSessionContext = {
  kind: "stageflow_guide";
  turn: number;
  confirmations: Confirmation[];
  threadId?: string;
};

export function guideContextOf(value: unknown): GuideSessionContext {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "stageflow_guide") {
    const v = value as Partial<GuideSessionContext>;
    return {
      kind: "stageflow_guide",
      turn: typeof v.turn === "number" ? v.turn : 0,
      confirmations: Array.isArray(v.confirmations) ? v.confirmations : [],
      ...(typeof v.threadId === "string" && v.threadId ? { threadId: v.threadId } : {}),
    };
  }
  return { kind: "stageflow_guide", turn: 0, confirmations: [] };
}

/** Call once per person message, before the session sees it. */
export function advanceGuideTurn(value: unknown): GuideSessionContext {
  const current = guideContextOf(value);
  const turn = current.turn + 1;
  return {
    ...current,
    turn,
    confirmations: current.confirmations.filter((c) => turn - c.turn <= CONFIRMATION_TURNS),
  };
}

function refusal(error: string, message: string): OperatorAgentToolResult {
  return { ok: false, error, content: { error, message } };
}

function callArgsWithoutConfirmation(args: Record<string, unknown>): Record<string, unknown> {
  const { confirmation_id: _ignored, ...rest } = args;
  return rest;
}

function mismatchRefusal(field: "tool" | "action" | "id", message: string): OperatorAgentToolResult {
  return refusal("guide.confirmation_mismatch", message || `The confirmation ${field} does not match.`);
}

export function createConfirmActionTool(): OperatorAgentTool {
  return {
    name: CONFIRM_ACTION_TOOL,
    description:
      "Ask the person to confirm an action before you take it. Required before starting runs, firing triggers, enabling agents or triggers, running evals, testing connections, importing tasks, and every delete or remove. Args: tool (the tool you want to call), summary (one plain sentence saying exactly what will happen). For merged tools with an action or mode field, also pass action and id when the tool needs them. Shows Yes/No choices. This call ends your reply. Do not call the action, show_ui, or confirm_action again until the person answers in a later message. Then call the tool once with confirmation_id.",
    parameters: Type.Object(
      {
        tool: Type.String({ minLength: 1 }),
        summary: Type.String({ minLength: 1 }),
        action: Type.Optional(Type.String({ minLength: 1 })),
        id: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    handler: (args, ctx) => {
      const tool = typeof args.tool === "string" ? args.tool.trim() : "";
      const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 300) : "";
      const action = typeof args.action === "string" ? args.action.trim() : undefined;
      const confirmId = typeof args.id === "string" ? args.id.trim() : undefined;
      if (!guideToolMayNeedConfirmation(tool)) {
        return refusal("guide.confirmation_not_needed", `${tool || "That tool"} does not need confirmation. Call it directly.`);
      }
      if (!summary) {
        return refusal("guide.confirmation_summary_required", "Say in one sentence what will happen.");
      }
      const fields = confirmFieldsForTool(tool, action);
      if (fields?.action === true && !action) {
        return refusal("guide.confirmation_field_required", "action is required for this tool.");
      }
      if (fields?.id === true && !confirmId) {
        return refusal("guide.confirmation_field_required", "id is required for this tool.");
      }
      const context = guideContextOf(ctx.getContext());
      const confirmation: Confirmation = {
        id: randomUUID().slice(0, 8),
        tool,
        summary,
        turn: context.turn,
        ...(action ? { action } : {}),
        ...(confirmId ? { confirmId } : {}),
      };
      ctx.setContext({ ...context, confirmations: [...context.confirmations, confirmation] });
      return {
        ok: true,
        content: {
          confirmation_id: confirmation.id,
          tool,
          next: "STOP. Do not call another tool. Write one plain sentence beside the card that says what will happen if they agree. Do not ask a question. The person has not answered, so wait for their next message.",
          ui: buildChoicesUi({
            question: summary,
            options: [
              { id: "yes", label: "Yes, go ahead" },
              { id: "no", label: "No, don't" },
            ],
            allowOther: true,
          }),
        },
      };
    },
  };
}

/** Consumes a confirmation issued in an earlier turn for this tool. */
export function checkGuideConfirmation(
  tool: string,
  args: Record<string, unknown>,
  ctx: OperatorAgentToolContext,
): OperatorAgentToolResult | null {
  const callArgs = callArgsWithoutConfirmation(args);
  const outcome = guideConfirmationOutcome(tool, callArgs);
  if (outcome === "none") return null;

  const id = typeof args.confirmation_id === "string" ? args.confirmation_id : "";
  const context = guideContextOf(ctx.getContext());
  const match = context.confirmations.find((c) => c.id === id);
  if (!match || match.tool !== tool) {
    return refusal(
      "guide.confirmation_required",
      `Call ${CONFIRM_ACTION_TOOL} with tool "${tool}" first, wait for the person to agree, then call ${tool} again with confirmation_id.`,
    );
  }
  if (match.turn >= context.turn) {
    return refusal(
      "guide.confirmation_pending",
      "The person has not answered yet. End your reply and wait for their answer.",
    );
  }

  const resolved = resolvedModeForCall(tool, callArgs);
  if (guideToolRequiresConfirmAction(tool) || match.action !== undefined) {
    if (!match.action) {
      return mismatchRefusal("action", "The confirmation is missing action.");
    }
    if (!resolved || resolved.mode !== match.action) {
      return mismatchRefusal("action", "The confirmation action does not match this call.");
    }
  }
  if (resolved?.primaryId) {
    if (match.confirmId === undefined) {
      return mismatchRefusal("id", "The confirmation is missing id.");
    }
    if (match.confirmId !== resolved.primaryId) {
      return mismatchRefusal("id", "The confirmation id does not match this call.");
    }
  } else if (match.confirmId !== undefined) {
    return mismatchRefusal("id", "The confirmation id does not match this call.");
  }

  ctx.setContext({ ...context, confirmations: context.confirmations.filter((c) => c.id !== id) });
  return null;
}