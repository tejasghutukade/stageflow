import { UI_PART_KIND_CARD } from "../artifacts/uiPart.js";
import { CardsUnavailableError, type CardSource, type FoundCard } from "../genui/cards.js";
import type { AgentMessage } from "./store.js";

/**
 * The cards an agent session has shown, newest first, from its stored messages. A card is stored when its reply ends,
 * so a card drawn in the reply still running is not here yet. Its id is `<message id>:<part index>`.
 */
export function agentSessionCards(messages: () => Promise<readonly AgentMessage[]>): CardSource {
  return {
    notFoundCode: "ui.card_not_found",
    async list() {
      let stored: readonly AgentMessage[];
      try {
        stored = await messages();
      } catch {
        throw new CardsUnavailableError("This conversation's messages could not be read");
      }
      const cards: FoundCard[] = [];
      for (const message of [...stored].reverse()) {
        if (message.role !== "assistant") continue;
        const parts = message.parts ?? [];
        for (let index = parts.length - 1; index >= 0; index -= 1) {
          const part = parts[index]!;
          if (part.kind === UI_PART_KIND_CARD) cards.push({ id: `${message.id}:${index}`, card: part });
        }
      }
      return cards;
    },
  };
}
