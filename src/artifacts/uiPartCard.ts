import { z } from "zod";
import { CONVERSATION_CARD_KINDS } from "./presentableKinds.js";
import { UI_PART_SCHEMA_VERSION, capFallbackText } from "./uiPartShared.js";

export { CONVERSATION_CARD_KINDS, isConversationCardKind, type ConversationCardKind } from "./presentableKinds.js";

/** A card an agent drew in one conversation. The program lives in the message, not in the artifact store. */
export const UI_PART_KIND_CARD = "card" as const;

export const CARD_PROGRAM_MAX_BYTES = 64 * 1024;

const htmlLibraryRef = z.object({ name: z.string(), version: z.string() });

const cardSchema = z.object({
  v: z.literal(UI_PART_SCHEMA_VERSION),
  kind: z.literal(UI_PART_KIND_CARD),
  title: z.string(),
  format: z.enum(CONVERSATION_CARD_KINDS),
  program: z.string().max(CARD_PROGRAM_MAX_BYTES),
  library: z.object({ name: z.string(), version: z.string() }).optional(),
  libraries: z.array(htmlLibraryRef).max(6).optional(),
  fallback: z.object({ text: z.string(), url: z.string() }),
});

export type UiPartCard = z.infer<typeof cardSchema>;

export function parseUiPartCard(value: unknown): { ok: true; part: UiPartCard } | { ok: false } {
  try {
    const parsed = cardSchema.safeParse(value);
    if (!parsed.success) return { ok: false };
    return { ok: true, part: capFallbackText(parsed.data) };
  } catch {
    return { ok: false };
  }
}
