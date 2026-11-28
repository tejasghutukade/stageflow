import type { ReactNode } from "react";
import type { UiPartCard } from "../../../../src/artifacts/uiPartCard.ts";
import type { LivePreviewInput } from "../../redesign/artifacts/livePreview";
import type { LiveHtmlFrameProps } from "../../redesign/artifacts/liveHtml/LiveHtmlFrame";
import type { StaticPreview } from "../../redesign/artifacts/renderers/previewModel";

/** A chat card's body: the program as the card carries it. A card has no bindings. */
export type CardFormatProps = {
  card: UiPartCard;
  /** Stable per program, for renderers that key caches by artifact. */
  identity: string;
};

/** A saved artifact's body on the artifact page or inline in chat. */
export type ArtifactFormatProps = {
  title: string;
  preview: StaticPreview | null;
  imageUrl?: string | null;
  program?: string | null;
  livePreview?: LivePreviewInput | null;
  liveHtml?: LiveHtmlFrameProps | null;
  historicalSnapshots?: boolean;
  showSourceDetails: boolean;
};

/**
 * How one generative UI kind (`live.declarative`, `live.html`, `static.markdown`, ...) renders as a chat card and as a
 * saved artifact. A new card-capable kind registers one entry here; heavy renderers stay behind `lazy` imports.
 */
export type FormatRenderer = {
  card?: (props: CardFormatProps) => ReactNode;
  artifact?: (props: ArtifactFormatProps) => ReactNode;
};

const formats = new Map<string, FormatRenderer>();

export function registerFormatRenderer(kind: string, renderer: FormatRenderer): void {
  formats.set(kind, renderer);
}

export function lookupFormatRenderer(kind: string): FormatRenderer | undefined {
  return formats.get(kind);
}
