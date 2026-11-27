import {
  CONVERSATION_CARD_KINDS,
  genUiPresentPrompt,
  htmlSignal,
  PRESENT_UI_TOOL_NAME,
  presentUiSpec,
  surfaceKey,
  toOperatorTool,
  TurnBudgets,
  type SurfacePolicy,
} from "../genui/index.js";
import type { McpToolDeps } from "../mcp/deps.js";
import { guideContextOf } from "../operatorAgent/profiles/guideConfirm.js";
import type { OperatorAgentTool, OperatorAgentToolContext } from "../operatorAgent/types.js";

export const GUIDE_PRESENT_UI_TOOL_NAMES = [PRESENT_UI_TOOL_NAME] as const;

export type GuideHtmlCardsSignal = boolean | (() => boolean);

/** The Guide draws cards kept in its thread and saves them with save_card; the kinds are listed in the playbook, which is resolved per session. */
export function guideSurfacePolicy(htmlCardsReachable?: GuideHtmlCardsSignal): SurfacePolicy {
  return {
    canPresent: true,
    kinds: CONVERSATION_CARD_KINDS,
    htmlCardsReachable: htmlSignal(htmlCardsReachable),
    cardsInConversation: true,
    canShowSaved: false,
    canSave: true,
    canPublish: false,
    describeKinds: false,
  };
}

const GUIDE_CARD_RULES = `## Generative cards in this chat

- When a question is about numbers or comparisons (runs, evals, costs, sessions), answer with a chart or table card with present_ui when it helps.
- Plot only numbers a tool returned. If no tool returned the number, say so instead of drawing.
- For run counts over time or by pipeline, call run_stats, then draw from its numbers. Never count a get_run list yourself.
- show_ui stays for plans, choices, links, resources and eval reports. Do not use present_ui for those.
- One card per answer unless the person asks for more. When they ask to change a card, draw the whole updated card again with present_ui.
- When the person asks to keep or save a card, call save_card. Leave card_id out for the latest card, or pass the card's title to pick an earlier one. Do not draw the card again to save it. A card stays only in this chat until they ask to save it.
- confirm_action and show_ui rules in this playbook still apply. A reply that must end on show_ui or confirm_action alone does not also call present_ui.`;

export function guidePresentUiPlaybookSection(htmlCardsReachable?: GuideHtmlCardsSignal): string {
  return `${genUiPresentPrompt(guideSurfacePolicy(htmlCardsReachable))}\n\n${GUIDE_CARD_RULES}`;
}

export function createGuidePresentUiTool(
  deps: McpToolDeps,
  options: { htmlCardsAvailable?: GuideHtmlCardsSignal } = {},
): OperatorAgentTool {
  const policy = guideSurfacePolicy(options.htmlCardsAvailable);
  const projectRoot = deps.projectRoot ?? deps.cwd;
  const budgets = new TurnBudgets();
  return toOperatorTool<OperatorAgentToolContext>(presentUiSpec(policy), (ctx) => {
    const context = guideContextOf(ctx.getContext());
    const threadId = context.threadId?.trim() || "guide";
    const key = surfaceKey("guide", threadId);
    return { key, id: threadId, owner: { kind: "guide" }, projectRoot, policy, budget: budgets.for(key, context.turn) };
  });
}
