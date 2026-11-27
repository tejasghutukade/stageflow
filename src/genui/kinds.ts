import { isUtf8 } from "node:buffer";
import { assertHtmlDocumentAtPublish } from "../artifacts/htmlScan.js";
import { validateHtmlManifest, type HtmlCsp, type HtmlManifest } from "../artifacts/htmlManifest.js";
import {
  ArtifactPublishError,
  LIVE_HTML_MAX_BYTES,
  LIVE_PROGRAM_MAX_BYTES,
  STATIC_CONTENT_MAX_BYTES,
  type ArtifactIssue,
} from "../artifacts/limits.js";
import { declarativePromptSection, htmlCardPromptSection, htmlPromptSection } from "../artifacts/livePrompt.js";
import { validateLiveManifest, type LiveManifest } from "../artifacts/manifest.js";
import { assertLiveProgramAtPublish } from "../artifacts/program.js";
import { CARD_PROGRAM_MAX_BYTES } from "../artifacts/uiPartCard.js";
import { isConversationCardKind, isPresentableArtifactKind } from "./kindsList.js";

export {
  CONVERSATION_CARD_KINDS,
  defaultPresentKinds,
  isConversationCardKind,
  isPresentableArtifactKind,
  PRESENTABLE_ARTIFACT_KINDS,
  UI_PERSISTENCE_VALUES,
  type ConversationCardKind,
  type PresentableArtifactKind,
  type UiPersistence,
} from "./kindsList.js";

/** "card" is a display-only card kept in the conversation; "artifact" is a published artifact. */
export type GenUiMode = "card" | "artifact";

export type GenUiContent = { live?: LiveManifest; html?: HtmlManifest };

export type GenUiParseInput = {
  manifest: unknown;
  /** The program or document text. Read lazily: static content can be large binary. */
  text: () => string;
  /** Raw bytes when the caller has them (publish); checked for UTF-8 in artifact mode. */
  bytes?: Buffer;
  mode: GenUiMode;
};

export type GenUiCheckInput = { content: GenUiContent; text: () => string; projectRoot: string; mode: GenUiMode };

export type GenUiKind = {
  id: string;
  limits: { cardBytes?: number; artifactBytes: number };
  canBeCard: boolean;
  presentable: boolean;
  /** Checks the manifest shape without touching the project. Throws ArtifactPublishError. */
  parse(input: GenUiParseInput): GenUiContent;
  /** Checks the program or document against the project (functions, components, HTML scan). Returns warnings. */
  check(input: GenUiCheckInput): Promise<ArtifactIssue[]>;
  /** The publish manifest for a one-off program presented as a session artifact; undefined for static kinds. */
  toArtifactManifest(manifest: Record<string, unknown>, program: string): Record<string, unknown> | undefined;
  promptSection?(mode: GenUiMode): string;
};

function fail(code: string, path: string, message: string, status = 400): never {
  throw new ArtifactPublishError(status, code, message, [{ path, message }]);
}

function displayOnly(message: string): never {
  throw new ArtifactPublishError(400, "ui.card_display_only", message);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function requireLiveInput(input: GenUiParseInput, label: string): void {
  if (input.bytes && !isUtf8(input.bytes)) fail("artifact.invalid_shape", "content", `${label} must be valid UTF-8`);
  if (input.manifest === undefined) fail("artifact.invalid_shape", "manifest", "manifest is required for a live artifact");
}

function htmlCspDeclaresNetwork(csp: HtmlCsp): boolean {
  return (csp.connectDomains?.length ?? 0) > 0 || (csp.resourceDomains?.length ?? 0) > 0
    || (csp.baseUriDomains?.length ?? 0) > 0 || (csp.frameDomains?.length ?? 0) > 0;
}

const liveDeclarative: GenUiKind = {
  id: "live.declarative",
  limits: { cardBytes: CARD_PROGRAM_MAX_BYTES, artifactBytes: LIVE_PROGRAM_MAX_BYTES },
  canBeCard: true,
  presentable: true,
  parse(input) {
    if (input.mode === "artifact") {
      requireLiveInput(input, "Program");
      return { live: validateLiveManifest(input.manifest, input.text()) };
    }
    const manifest = record(input.manifest);
    if (nonEmptyList(manifest.bindings) || nonEmptyList(manifest.actions)) {
      displayOnly("A card shows only what you write into it: set bindings to [] and leave out actions, and put the data in the program as literals");
    }
    const program = input.text();
    return { live: validateLiveManifest({ ...manifest, bindings: [], program }, program) };
  },
  async check(input) {
    return input.content.live ? assertLiveProgramAtPublish(input.projectRoot, input.content.live) : [];
  },
  toArtifactManifest: (manifest, program) => ({ ...manifest, program, kind: "live.declarative" }),
  promptSection: () => declarativePromptSection(),
};

const liveHtml: GenUiKind = {
  id: "live.html",
  limits: { cardBytes: CARD_PROGRAM_MAX_BYTES, artifactBytes: LIVE_HTML_MAX_BYTES },
  canBeCard: true,
  presentable: true,
  parse(input) {
    if (input.mode === "artifact") {
      requireLiveInput(input, "HTML");
      return { html: validateHtmlManifest(input.manifest) };
    }
    const manifest = record(input.manifest);
    if (nonEmptyList(manifest.bindings) || nonEmptyList(manifest.actions) || (manifest.refresh !== undefined && manifest.refresh !== null)) {
      displayOnly("An HTML card is display-only: leave out bindings, actions, refresh, and external csp origins; put data in the HTML and use vendored libraries only");
    }
    if (typeof manifest.key === "string" && manifest.key.trim().length > 0) {
      displayOnly("An HTML card cannot reference a saved artifact; write the HTML into program");
    }
    const { kind: _kind, ...rest } = manifest;
    const html = validateHtmlManifest({ ...rest, format: "html", bindings: [] }, { enforceEval: true });
    if (htmlCspDeclaresNetwork(html.csp)) {
      displayOnly("An HTML card cannot declare network or external origins: omit csp or leave every list empty");
    }
    return { html };
  },
  async check(input) {
    return input.content.html ? assertHtmlDocumentAtPublish(input.text(), input.content.html.csp) : [];
  },
  toArtifactManifest: (manifest) => {
    const { kind: _kind, program: _program, ...rest } = manifest;
    return rest;
  },
  promptSection: (mode) => (mode === "card" ? htmlCardPromptSection() : htmlPromptSection()),
};

function staticKind(id: string): GenUiKind {
  const canBeCard = isConversationCardKind(id);
  return {
    id,
    limits: canBeCard ? { cardBytes: CARD_PROGRAM_MAX_BYTES, artifactBytes: STATIC_CONTENT_MAX_BYTES } : { artifactBytes: STATIC_CONTENT_MAX_BYTES },
    canBeCard,
    presentable: isPresentableArtifactKind(id),
    parse(input) {
      if (input.mode === "artifact" && input.manifest !== undefined) {
        fail("artifact.invalid_shape", "manifest", "manifest is only valid for a live artifact");
      }
      return {};
    },
    check: async () => [],
    toArtifactManifest: () => undefined,
  };
}

const GENUI_KINDS: ReadonlyMap<string, GenUiKind> = new Map(
  [
    liveDeclarative,
    liveHtml,
    staticKind("static.markdown"),
    staticKind("static.image"),
    staticKind("static.table"),
    staticKind("static.text"),
    staticKind("static.html"),
  ].map((kind) => [kind.id, kind]),
);

export function genUiKind(id: string): GenUiKind | undefined {
  return GENUI_KINDS.get(id);
}

export function genUiKinds(): readonly GenUiKind[] {
  return [...GENUI_KINDS.values()];
}
