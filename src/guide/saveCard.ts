import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";
import { CardsUnavailableError, type CardSource, type FoundCard } from "../genui/cards.js";
import { readPresentUiCard } from "../genui/parts.js";
import { PRESENT_UI_TOOL_NAME, SAVE_CARD_TOOL_NAME, saveCardSpec } from "../genui/tools.js";
import { surfaceKey } from "../genui/surface.js";
import { toOperatorTool } from "../genui/adapters/operator.js";
import type { McpToolDeps } from "../mcp/deps.js";
import { consoleUrl } from "../mcp/writeTarget.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";
import { guideContextOf } from "../operatorAgent/profiles/guideConfirm.js";
import type { OperatorAgentTool, OperatorAgentToolContext } from "../operatorAgent/types.js";
import { guideSurfacePolicy } from "./presentUi.js";
import { readGuideThread } from "./threadStore.js";

export { SAVE_CARD_TOOL_NAME } from "../genui/tools.js";
export const GUIDE_SAVE_CARD_TOOL_NAMES = [SAVE_CARD_TOOL_NAME] as const;

/** The cards a Guide thread has shown, newest first: completed present_ui calls, keyed by their call id. */
export function guideThreadCards(threadId: string | undefined): CardSource {
  return {
    notFoundCode: "guide.card_not_found",
    list() {
      if (!threadId) throw new CardsUnavailableError("This chat is not attached to a thread");
      const thread = readGuideThread(threadId);
      if (!thread) throw new CardsUnavailableError("This chat has no saved thread");
      const cards: FoundCard[] = [];
      for (const message of [...thread.messages].reverse()) {
        for (const part of [...(message.parts ?? [])].reverse()) {
          if (part.type !== "tool" || part.name !== PRESENT_UI_TOOL_NAME || part.status !== "complete") continue;
          const card = readPresentUiCard(part.result);
          if (card) cards.push({ id: part.id, card });
        }
      }
      return cards;
    },
  };
}

export function createGuideSaveCardTool(deps: McpToolDeps): OperatorAgentTool {
  const policy = guideSurfacePolicy();
  const projectRoot = defaultAgentProjectRoot(deps.projectRoot ?? deps.cwd);
  const artifacts = async () => {
    const db = sqliteConnectionFromStore(deps.store);
    if (!db) return undefined;
    return { db, roots: await catalogRootsForArtifacts(deps.store), consoleUrl: (hashPath: string) => consoleUrl(deps, hashPath) };
  };
  return toOperatorTool<OperatorAgentToolContext>(saveCardSpec("guide"), (ctx) => {
    const threadId = guideContextOf(ctx.getContext()).threadId?.trim() || undefined;
    return {
      key: surfaceKey("guide", threadId ?? "guide"),
      id: threadId ?? "guide",
      owner: { kind: "guide" },
      projectRoot,
      policy,
      artifacts,
      cards: guideThreadCards(threadId),
    };
  });
}
