import { Type } from "typebox";
import {
  agentPresentUiPrompt,
  CONVERSATION_CARD_KINDS,
  PRESENT_UI_TOOL_NAME,
  presentCard,
  presentCardParameterSchema,
} from "../genui/index.js";
import type { McpToolDeps } from "../mcp/deps.js";
import { guideContextOf, type GuideSessionContext } from "../operatorAgent/profiles/guideConfirm.js";
import type { OperatorAgentTool, OperatorAgentToolContext, OperatorAgentToolResult } from "../operatorAgent/types.js";

export const GUIDE_PRESENT_UI_TOOL_NAMES = [PRESENT_UI_TOOL_NAME] as const;

export type GuideHtmlCardsSignal = boolean | (() => boolean);

export function resolveGuideHtmlCardsAvailable(signal?: GuideHtmlCardsSignal): boolean {
  if (typeof signal === "function") return signal();
  return signal === true;
}

export function guidePresentKinds(htmlCardsAvailable: boolean): readonly string[] {
  return htmlCardsAvailable ? [...CONVERSATION_CARD_KINDS] : ["live.declarative", "static.markdown"];
}

export function guidePresentUiPlaybookSection(htmlCardsAvailable: boolean): string {
  const prompt = agentPresentUiPrompt(
    {
      ui: {
        present: true,
        persistence: "conversation",
        kinds: [...guidePresentKinds(htmlCardsAvailable)],
        functions: [],
      },
    },
    { htmlCardsAvailable },
  );
  if (!prompt) return "";
  return `${prompt}

## Generative cards in this chat

- When a question is about numbers or comparisons (runs, evals, costs, sessions), answer with a chart or table card with present_ui when it helps.
- Plot only numbers a tool returned. If no tool returned the number, say so instead of drawing.
- For run counts over time or by pipeline, call run_stats, then draw from its numbers. Never count a get_run list yourself.
- show_ui stays for plans, choices, links, resources and eval reports. Do not use present_ui for those.
- One card per answer unless the person asks for more. When they ask to change a card, draw the whole updated card again with present_ui.
- When the person asks to keep or save a card, call save_card. Leave card_id out for the latest card, or pass the card's title to pick an earlier one. Do not draw the card again to save it. A card stays only in this chat until they ask to save it.
- confirm_action and show_ui rules in this playbook still apply. A reply that must end on show_ui or confirm_action alone does not also call present_ui.`;
}

function presentToolFailure(code: string, message: string): OperatorAgentToolResult {
  return { ok: false, content: { code, message }, error: code };
}

function bumpPresentCount(ctx: OperatorAgentToolContext, threadId: string): GuideSessionContext {
  const current = guideContextOf(ctx.getContext());
  const next = {
    ...current,
    threadId,
    presentUiInTurn: (current.presentUiInTurn ?? 0) + 1,
  };
  ctx.setContext(next);
  return next;
}

export function createGuidePresentUiTool(
  deps: McpToolDeps,
  options: { htmlCardsAvailable?: GuideHtmlCardsSignal } = {},
): OperatorAgentTool {
  const kindsFor = () => guidePresentKinds(resolveGuideHtmlCardsAvailable(options.htmlCardsAvailable));
  const projectRoot = deps.projectRoot ?? deps.cwd;
  return {
    name: PRESENT_UI_TOOL_NAME,
    // Neutral on purpose: the tool is built before the sandbox listener starts; the playbook (resolved per session) lists the kinds.
    description: `Draw a generative card in this conversation (charts, tables, markdown, and the other kinds the playbook lists). Pass program, manifest (with kind) and a title. The card shows only what the program contains. To change a card, call again with the full updated program.`,
    parameters: presentCardParameterSchema() as ReturnType<typeof Type.Object>,
    handler: async (args, ctx) => {
      const record = args;
      const program = record.program;
      const manifest = record.manifest;
      const title = record.title;
      if (typeof program !== "string") return presentToolFailure("artifact.invalid_shape", "program is required");
      if (manifest === undefined || manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
        return presentToolFailure("artifact.invalid_shape", "manifest is required");
      }
      if (title !== undefined && typeof title !== "string") {
        return presentToolFailure("artifact.invalid_id", "Title must be text");
      }
      const context = guideContextOf(ctx.getContext());
      const threadId = context.threadId?.trim() || "guide";
      // Reserve the slot before awaiting, so parallel calls in one reply each count toward the per-message cap.
      const presentedInMessage = bumpPresentCount(ctx, threadId).presentUiInTurn ?? 1;
      const allowedKinds = kindsFor();
      const result = await presentCard({
        projectRoot,
        sessionId: `guide:${threadId}`,
        ...(typeof title === "string" ? { title } : {}),
        program,
        manifest,
        presentedInMessage,
        allowedKinds,
      });
      if (!result.ok) {
        const current = guideContextOf(ctx.getContext());
        ctx.setContext({ ...current, presentUiInTurn: Math.max(0, (current.presentUiInTurn ?? 1) - 1) });
        return presentToolFailure(result.code, result.message);
      }
      return { ok: true, content: result.envelope };
    },
  };
}