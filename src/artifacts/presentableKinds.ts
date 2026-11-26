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
