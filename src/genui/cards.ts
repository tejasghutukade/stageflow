import type { UiPartCard } from "../artifacts/uiPartCard.js";

export type FoundCard = { id: string; card: UiPartCard };

/** Where save_card finds the cards a conversation has shown: a Guide thread, an agent session's stored messages. */
export type CardSource = {
  /** The error code for "no such card" on this surface. */
  notFoundCode: string;
  /** Cards newest first. Throws CardsUnavailableError when the conversation has no store to read. */
  list(): Promise<FoundCard[]> | FoundCard[];
};

export class CardsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardsUnavailableError";
  }
}

/**
 * The card to save, from cards newest first: the one with that id, else the one with that title (case-insensitive),
 * else (no ref given) the latest. The model rarely sees its own tool call ids, so people say "save this chart".
 */
export function pickCard(cards: readonly FoundCard[], ref?: string): FoundCard | null {
  const wanted = ref?.trim() ?? "";
  if (!wanted) return cards[0] ?? null;
  const lower = wanted.toLowerCase();
  return cards.find((entry) => entry.id === wanted) ?? cards.find((entry) => entry.card.title.trim().toLowerCase() === lower) ?? null;
}

export async function findCard(source: CardSource, ref?: string): Promise<FoundCard | null> {
  return pickCard(await source.list(), ref);
}
