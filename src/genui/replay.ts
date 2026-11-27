import { UI_PART_KIND_CARD, type UiPart, type UiPartArtifactRef, type UiPartCard } from "../artifacts/uiPart.js";
import { isPresentedUiPart, readPresentUiCard } from "./parts.js";
import { PRESENT_UI_TOOL_NAME } from "./tools.js";

/** Characters of a card program kept when a session is replayed; most cards fit, so the agent can still edit them. */
export const REPLAY_PROGRAM_MAX = 12_000;

export function replayUiPart(part: UiPartArtifactRef | UiPartCard): unknown {
  if (part.kind !== UI_PART_KIND_CARD || part.program.length <= REPLAY_PROGRAM_MAX) return { type: "ui", ui: part };
  const said = `Replay kept the first ${REPLAY_PROGRAM_MAX} of ${part.program.length} characters. This card is incomplete here: to change it, write the whole card again.`;
  const note = part.format === "live.html" ? `<!-- ${said} -->` : `[${said}]`;
  return { type: "ui", ui: { ...part, program: `${part.program.slice(0, REPLAY_PROGRAM_MAX)}\n${note}` } };
}

/** Replay text keeps the structured ui envelope beside the reply, so a restored session is not only the fallback sentence. A card keeps its program, so the agent can change it later. */
export function messageReplayText(message: { text: string; parts?: readonly UiPart[] }): string {
  const text = message.text.trim();
  const ui = (message.parts ?? [])
    .filter(isPresentedUiPart)
    .map((part) => JSON.stringify(replayUiPart(part)))
    .join("\n");
  if (!ui) return text;
  return text ? `${text}\n${ui}` : ui;
}

export type ReplayToolPart = { type: string; name?: string; status?: string; result?: unknown };

/** Replay text for a message that stores tool calls as parts (the Guide thread): completed present_ui cards ride along. */
export function toolPartsReplayText(message: { text: string; parts?: ReadonlyArray<ReplayToolPart> }): string {
  const parts: UiPart[] = [];
  for (const part of message.parts ?? []) {
    if (part.type !== "tool" || part.name !== PRESENT_UI_TOOL_NAME || part.status !== "complete") continue;
    const card = readPresentUiCard(part.result);
    if (card) parts.push(card);
  }
  if (parts.length === 0) return message.text.trim();
  return messageReplayText({ text: message.text, parts });
}
