import type { BindableFunctionInfo } from "../artifacts/bindable.js";
import {
  ARTIFACT_DESCRIPTION_MAX_CHARS,
  ARTIFACT_SUMMARY_MAX_CHARS,
  ARTIFACT_TAG_MAX,
  ARTIFACT_TITLE_MAX_CHARS,
  LIVE_HTML_MAX_BYTES,
  LIVE_PROGRAM_MAX_BYTES,
  STATIC_CONTENT_MAX_BYTES,
} from "../artifacts/limits.js";
import { liveArtifactsPromptSection } from "../artifacts/livePrompt.js";
import type { AgentDefinition } from "../config/loadAgent.js";
import { genUiKind } from "./kinds.js";
import { PUBLISH_KINDS } from "./kindsList.js";
import { htmlSignal, inlineKinds, uiPolicy, type SurfacePolicy } from "./surface.js";

export const AGENT_PRESENT_UI_SENTENCE =
  "You can place an artifact from this project into the conversation with present_ui. Pass its key, or pass program and manifest to show a one-off chart or table without publishing first. Pass version only when the person should see that version. The chat shows the artifact; do not paste its body into the reply. If present_ui returns a validation error, fix the program and call it again.";

export const AGENT_PRESENT_CARD_SENTENCE =
  "You can draw a card in this conversation with present_ui: pass program, manifest (with kind) and a short title. The card shows only what you write into the program, so put the numbers and text in it; it cannot load live data or run actions. Cards belong to this conversation and are not saved anywhere else. To change a card, call present_ui again with the complete updated program and a title that matches it; the person sees the new card below the old one. The chat shows the card; do not paste its program into the reply. If present_ui returns a validation error, fix the program and call it again.";

/** How to save a card, shared by the Guide playbook and agents that get save_card. */
export const SAVE_CARD_SENTENCE =
  "When the person asks to keep or save a card, call save_card. Leave card_id out for the latest card, or pass the card's title to pick an earlier one. Do not draw the card again to save it.";

type PresentPromptPolicy = Pick<SurfacePolicy, "canPresent" | "kinds" | "htmlCardsReachable" | "cardsInConversation"> & Partial<Pick<SurfacePolicy, "canSave">>;

/**
 * The present_ui section: drawing cards (conversation) or showing artifacts (artifacts mode). Cards list only the kinds a
 * card may use now. A surface that saves cards gets the save line, unless its playbook states it (`saveRuleInPlaybook`).
 */
export function genUiPresentPrompt(policy: PresentPromptPolicy, options: { saveRuleInPlaybook?: boolean } = {}): string | undefined {
  if (!policy.canPresent) return undefined;
  const conversation = policy.cardsInConversation;
  const oneOff = inlineKinds(policy);
  const listed = conversation ? oneOff : policy.kinds;
  const kinds = listed.length > 0 ? listed.join(", ") : "none while HTML cards are unavailable on this Host";
  const oneOffKinds = oneOff.length > 0 ? oneOff.join(", ") : "none while HTML cards are unavailable on this Host";
  const mode = conversation ? "card" : "artifact";
  const sections = conversation
    ? ["# Drawing cards in chat", "", `${AGENT_PRESENT_CARD_SENTENCE} Kinds you may draw: ${kinds}.`]
    : ["# Showing artifacts in chat", "", `${AGENT_PRESENT_UI_SENTENCE} Kinds you may show by key: ${kinds}. One-off programs: ${oneOffKinds}.`];
  if (!conversation && policy.kinds.includes("live.html") && !oneOff.includes("live.html")) {
    sections.push("", "A one-off live.html program is refused while the HTML sandbox is unreachable. Show a saved live.html artifact by key.");
  }
  if (conversation && policy.canSave === true && options.saveRuleInPlaybook !== true) {
    sections.push("", `${SAVE_CARD_SENTENCE} A card can be saved once it has been shown, in a later message.`);
  }
  if (listed.includes("live.declarative")) {
    sections.push("", genUiKind("live.declarative")!.promptSection!(mode));
    if (conversation)
      sections.push(
        "",
        "In a card, bindings must be [] and there are no actions: write the data into the program as literals.",
        "When a chart type is not quite right, still draw the closest chart or a row of Stat values; do not reply that a component is unavailable.",
      );
  }
  if ((conversation ? oneOff : policy.kinds).includes("live.html")) {
    sections.push("", genUiKind("live.html")!.promptSection!(mode));
  }
  return sections.join("\n");
}

export function agentPresentUiPrompt(
  definition: Pick<AgentDefinition, "ui">,
  options: { htmlCardsAvailable?: boolean } = {},
): string | undefined {
  return genUiPresentPrompt(uiPolicy(definition.ui, htmlSignal(options.htmlCardsAvailable)));
}

/** Where the publish section differs between callers: a stage attempt or an agent. */
export type PublishPromptContext = {
  publisher: "stage" | "agent";
  /** Stage: ids to publish before a success envelope. */
  expect?: readonly string[];
  /** Paragraphs placed before the live artifact section (an agent's artifact read sentence). */
  notes?: readonly string[];
  functions?: readonly BindableFunctionInfo[];
};

function publishKindsLine(publisher: PublishPromptContext["publisher"]): string {
  const mib = Math.floor(STATIC_CONTENT_MAX_BYTES / (1024 * 1024));
  const declarativeKiB = Math.round(LIVE_PROGRAM_MAX_BYTES / 1024);
  const live =
    publisher === "stage"
      ? `A live.declarative program is the content string, at most ${declarativeKiB} KiB, with format, library, bindings, and optional refresh. live.html is one HTML document, at most ${Math.round(LIVE_HTML_MAX_BYTES / 1024)} KiB, with format, csp, libraries, bindings, and optional refresh.`
      : `A live.declarative program is the content string, at most ${declarativeKiB} KiB. live.html takes format, csp, libraries, bindings, and optional refresh.`;
  return `Kinds: ${PUBLISH_KINDS.join(", ")}. Static content is at most ${mib} MiB. ${live} The title is at most ${ARTIFACT_TITLE_MAX_CHARS} characters. You may set at most ${ARTIFACT_TAG_MAX} tags, each matching [a-z0-9_-] and at most 32 characters. Description and summary are at most ${ARTIFACT_DESCRIPTION_MAX_CHARS} and ${ARTIFACT_SUMMARY_MAX_CHARS} characters.`;
}

const PUBLISH_TEXT = {
  stage: {
    use: "Use publish_artifact for a final deliverable a person should open later. Skip scratch notes, logs, and intermediate files.",
    unchanged: " That unchanged publish still counts for this attempt.",
    path: "Give path, content, or content_base64, and only one of them. path is a run-relative path inside this attempt's artifacts directory, or a path relative to that directory. content is inline text. content_base64 is an image (png, jpeg, gif, or webp).",
  },
  agent: {
    use: "Use publish_artifact for a final deliverable a person should open later. Skip scratch notes, logs, and intermediate files. Artifacts you publish are owned by this agent. This prompt does not list other agents' artifacts.",
    unchanged: "",
    path: "Give path, content, or content_base64, and only one of them. path is relative to the project root. It must stay inside the project, must not be absolute, must not contain .., must not name an agent definition, must not point under the Stageflow home, and must not be a symlink. content is inline text. content_base64 is an image (png, jpeg, gif, or webp).",
  },
} as const;

/** The publish_artifact section of a stage or agent system prompt. */
export function genUiPublishPrompt(context: PublishPromptContext): string {
  const text = PUBLISH_TEXT[context.publisher];
  const lines = [
    "# Published artifacts",
    "",
    text.use,
    "",
    `The id is a lowercase slug: it starts with a letter, then has up to 63 letters, digits, underscores, or hyphens (\`^[a-z][a-z0-9_-]{0,63}$\`). Publishing the same id again creates a new version. If the bytes and kind are unchanged, the current version is kept and the tool returns unchanged.${text.unchanged}`,
    "",
    publishKindsLine(context.publisher),
    "",
    text.path,
  ];
  if (context.publisher === "stage") {
    lines.push(
      "",
      "Files you list on the success envelope are indexed automatically. publish_artifact is different: it stores a titled, versioned artifact that remains after the run.",
    );
  }
  if (context.expect !== undefined && context.expect.length > 0) {
    lines.push("", `Before a success envelope, publish every id in this list: ${context.expect.join(", ")}.`);
  }
  for (const note of context.notes ?? []) lines.push("", note);
  lines.push("", liveArtifactsPromptSection(context.functions ?? []));
  return lines.join("\n");
}
