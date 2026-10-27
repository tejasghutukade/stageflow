import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { buildChoicesUi } from "../../guide/cardContract.js";
import { TOOL_META } from "../../toolkit/meta.js";
import type { OperatorAgentTool, OperatorAgentToolContext, OperatorAgentToolResult } from "../types.js";

export const CONFIRM_ACTION_TOOL = "confirm_action";

const CONFIRMATION_TURNS = 3;

const ALWAYS_CONFIRMED = [
  "start_run",
  "run_stage",
  "rerun",
  "retry_stage",
  "resume_stage",
  "recover_manual_stage",
  "enable_agent",
  "set_trigger_enabled",
];

const NEVER_CONFIRMED = new Set(["probe_project_mcp"]);

export const GUIDE_CONFIRMED_TOOLS: ReadonlySet<string> = new Set([
  ...ALWAYS_CONFIRMED,
  ...Object.entries(TOOL_META)
    .filter(([name, meta]) => (meta.risk === "external" || meta.risk === "destructive") && !NEVER_CONFIRMED.has(name))
    .map(([name]) => name),
]);

type Confirmation = { id: string; tool: string; summary: string; turn: number };

export type GuideSessionContext = {
  kind: "stageflow_guide";
  turn: number;
  confirmations: Confirmation[];
};

export function guideContextOf(value: unknown): GuideSessionContext {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "stageflow_guide") {
    const v = value as Partial<GuideSessionContext>;
    return {
      kind: "stageflow_guide",
      turn: typeof v.turn === "number" ? v.turn : 0,
      confirmations: Array.isArray(v.confirmations) ? v.confirmations : [],
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

export function createConfirmActionTool(): OperatorAgentTool {
  return {
    name: CONFIRM_ACTION_TOOL,
    description:
      "Ask the person to confirm an action before you take it. Required before starting runs, firing triggers, enabling agents or triggers, running evals, testing connections, importing tasks, and every delete or remove. Args: tool (the tool you want to call), summary (one plain sentence saying exactly what will happen). Shows Yes/No choices. This call ends your reply. Do not call the action, show_ui, or confirm_action again until the person answers in a later message. Then call the tool once with confirmation_id.",
    parameters: Type.Object(
      {
        tool: Type.String({ minLength: 1 }),
        summary: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    handler: (args, ctx) => {
      const tool = typeof args.tool === "string" ? args.tool.trim() : "";
      const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 300) : "";
      if (!GUIDE_CONFIRMED_TOOLS.has(tool)) {
        return refusal("guide.confirmation_not_needed", `${tool || "That tool"} does not need confirmation. Call it directly.`);
      }
      if (!summary) {
        return refusal("guide.confirmation_summary_required", "Say in one sentence what will happen.");
      }
      const context = guideContextOf(ctx.getContext());
      const confirmation: Confirmation = { id: randomUUID().slice(0, 8), tool, summary, turn: context.turn };
      ctx.setContext({ ...context, confirmations: [...context.confirmations, confirmation] });
      return {
        ok: true,
        content: {
          confirmation_id: confirmation.id,
          tool,
          next: "STOP. Do not call another tool. The person has not answered. Wait for their next message.",
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
  const id = typeof args.confirmation_id === "string" ? args.confirmation_id : "";
  const context = guideContextOf(ctx.getContext());
  const match = context.confirmations.find((c) => c.id === id && c.tool === tool);
  if (!match) {
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
  ctx.setContext({ ...context, confirmations: context.confirmations.filter((c) => c.id !== id) });
  return null;
}
