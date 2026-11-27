/** Artifact kinds an agent may place in chat with `present_ui`. */
export const PRESENTABLE_ARTIFACT_KINDS = [
  "static.markdown",
  "static.image",
  "static.table",
  "static.text",
  "static.html",
  "live.declarative",
  "live.html",
] as const;

export type PresentableArtifactKind = (typeof PRESENTABLE_ARTIFACT_KINDS)[number];

export function isPresentableArtifactKind(kind: string): kind is PresentableArtifactKind {
  return (PRESENTABLE_ARTIFACT_KINDS as readonly string[]).includes(kind);
}

/** Kinds a card kept in the conversation can hold (`ui.persistence: conversation`). Both render from the message alone. */
export const CONVERSATION_CARD_KINDS = ["live.declarative", "static.markdown"] as const;

export type ConversationCardKind = (typeof CONVERSATION_CARD_KINDS)[number];

export function isConversationCardKind(kind: string): kind is ConversationCardKind {
  return (CONVERSATION_CARD_KINDS as readonly string[]).includes(kind);
}

export const UI_PERSISTENCE_VALUES = ["conversation", "artifacts"] as const;

export type UiPersistence = (typeof UI_PERSISTENCE_VALUES)[number];

/** Kinds an agent gets when `ui.present` is on and `ui.kinds` is left empty. */
export function defaultPresentKinds(persistence: UiPersistence): string[] {
  return persistence === "conversation" ? [...CONVERSATION_CARD_KINDS] : [...PRESENTABLE_ARTIFACT_KINDS];
}
