import type { AgentDefinition } from "../config/loadAgent.js";
import { genUiKind } from "./kinds.js";

export const AGENT_PRESENT_UI_SENTENCE =
  "You can place an artifact from this project into the conversation with present_ui. Pass its key, or pass program and manifest to show a one-off chart or table without publishing first. Pass version only when the person should see that version. The chat shows the artifact; do not paste its body into the reply. If present_ui returns a validation error, fix the program and call it again.";

export const AGENT_PRESENT_CARD_SENTENCE =
  "You can draw a card in this conversation with present_ui: pass program, manifest (with kind) and a short title. The card shows only what you write into the program, so put the numbers and text in it; it cannot load live data or run actions. Cards belong to this conversation and are not saved anywhere else. To change a card, call present_ui again with the complete updated program and a title that matches it; the person sees the new card below the old one. The chat shows the card; do not paste its program into the reply. If present_ui returns a validation error, fix the program and call it again.";

export function agentHoldsPresentUi(definition: Pick<AgentDefinition, "ui">): boolean {
  return definition.ui?.present === true;
}

/** Cards stay in the conversation unless the agent saves them as artifacts. */
export function agentKeepsCardsInConversation(definition: Pick<AgentDefinition, "ui">): boolean {
  return (definition.ui?.persistence ?? "conversation") === "conversation";
}

export function agentPresentUiPrompt(
  definition: Pick<AgentDefinition, "ui">,
  options: { htmlCardsAvailable?: boolean } = {},
): string | undefined {
  if (!agentHoldsPresentUi(definition)) return undefined;
  const kinds = definition.ui.kinds.join(", ");
  const conversation = agentKeepsCardsInConversation(definition);
  const mode = conversation ? "card" : "artifact";
  const sections = conversation
    ? ["# Drawing cards in chat", "", `${AGENT_PRESENT_CARD_SENTENCE} Kinds you may draw: ${kinds}.`]
    : ["# Showing artifacts in chat", "", `${AGENT_PRESENT_UI_SENTENCE} Kinds you may present: ${kinds}.`];
  if (definition.ui.kinds.includes("live.declarative")) {
    sections.push("", genUiKind("live.declarative")!.promptSection!(mode));
    if (conversation)
      sections.push(
        "",
        "In a card, bindings must be [] and there are no actions: write the data into the program as literals.",
        "When a chart type is not quite right, still draw the closest chart or a row of Stat values; do not reply that a component is unavailable.",
      );
  }
  if (definition.ui.kinds.includes("live.html") && (!conversation || options.htmlCardsAvailable === true)) {
    sections.push("", genUiKind("live.html")!.promptSection!(mode));
  }
  return sections.join("\n");
}
