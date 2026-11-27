import {
  parseUiPartEnvelope,
  UI_PART_KIND_ARTIFACT_REF,
  UI_PART_KIND_CARD,
  type UiPart,
  type UiPartArtifactRef,
  type UiPartCard,
} from "../artifacts/uiPart.js";
import { PRESENT_UI_TOOL_NAME } from "./tools.js";

/** True for a part that puts something on screen (an artifact or a card), as opposed to an error. */
export function isPresentedUiPart(part: UiPart): part is UiPartArtifactRef | UiPartCard {
  return part.kind === UI_PART_KIND_ARTIFACT_REF || part.kind === UI_PART_KIND_CARD;
}

export function uiPartsFromToolOutput(tool: string, output: string): Array<UiPartArtifactRef | UiPartCard> {
  if (tool !== PRESENT_UI_TOOL_NAME) return [];
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    return [];
  }
  const parsed = parseUiPartEnvelope(value);
  if (!parsed.ok) return [];
  return isPresentedUiPart(parsed.part) ? [parsed.part] : [];
}

/** The card in a present_ui tool result, or null for an artifact ref, an error or anything else. */
export function readPresentUiCard(result: unknown): UiPartCard | null {
  const envelope = parseUiPartEnvelope(result);
  if (!envelope.ok || envelope.part.kind !== UI_PART_KIND_CARD) return null;
  return envelope.part;
}
