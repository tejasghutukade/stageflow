import type { AgentDefinition } from "../config/loadAgent.js";
import { ARTIFACT_TITLE_MAX_CHARS, ArtifactPublishError } from "../artifacts/limits.js";
import { artifactStorageKey, parseOwnerKey, publicArtifactKey } from "../artifacts/keys.js";
import { isLiveKind, isPresentableArtifactKind } from "../artifacts/kinds.js";
import { storedProjectMatches } from "../artifacts/projectIdentity.js";
import { publishArtifact } from "../artifacts/publish.js";
import { ArtifactQueryError, readArtifact } from "../artifacts/query.js";
import {
  assertSessionArtifactCaps,
  newSessionArtifactId,
  sessionArtifactExpiresAt,
} from "../artifacts/sessionScope.js";
import { readArtifactVersionRow } from "../artifacts/versions.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { consoleUrl } from "../mcp/writeTarget.js";
import type { McpToolDeps } from "../mcp/deps.js";
import {
  CARD_PROGRAM_MAX_BYTES,
  isConversationCardKind,
  parseUiPartEnvelope,
  UI_PART_FALLBACK_TEXT_MAX_CHARS,
  UI_PART_KIND_ARTIFACT_REF,
  UI_PART_KIND_CARD,
  UI_PART_SCHEMA_VERSION,
  type UiPart,
  type UiPartArtifactRef,
  type UiPartCard,
  type UiPartEnvelope,
} from "../artifacts/uiPart.js";
import { validateLiveManifest } from "../artifacts/manifest.js";
import { assertLiveProgramAtPublish } from "../artifacts/program.js";
import { SlidingWindowLimiter } from "./webChat/rateLimit.js";
import {
  SESSION_ARTIFACT_RATE_LIMIT,
  SESSION_ARTIFACT_RATE_WINDOW_MS,
  SESSION_ARTIFACTS_PER_MESSAGE,
} from "../artifacts/sessionScope.js";
import { Type } from "typebox";
import { assertHtmlDocumentAtPublish } from "../artifacts/htmlScan.js";
import { validateHtmlManifest, type HtmlCsp } from "../artifacts/htmlManifest.js";
import { declarativePromptSection, htmlCardPromptSection, htmlPromptSection } from "../artifacts/livePrompt.js";

export const PRESENT_UI_TOOL_NAME = "present_ui";

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
  const sections = conversation
    ? ["# Drawing cards in chat", "", `${AGENT_PRESENT_CARD_SENTENCE} Kinds you may draw: ${kinds}.`]
    : ["# Showing artifacts in chat", "", `${AGENT_PRESENT_UI_SENTENCE} Kinds you may present: ${kinds}.`];
  if (definition.ui.kinds.includes("live.declarative")) {
    sections.push("", declarativePromptSection());
    if (conversation)
      sections.push(
        "",
        "In a card, bindings must be [] and there are no actions: write the data into the program as literals.",
        "When a chart type is not quite right, still draw the closest chart or a row of Stat values; do not reply that a component is unavailable.",
      );
  }
  if (definition.ui.kinds.includes("live.html")) {
    if (conversation && options.htmlCardsAvailable === true) sections.push("", htmlCardPromptSection());
    else if (!conversation) sections.push("", htmlPromptSection());
  }
  return sections.join("\n");
}

export function appendAgentPresentUiPrompt(
  systemPrompt: string,
  definition: Pick<AgentDefinition, "ui">,
  options: { htmlCardsAvailable?: boolean } = {},
): string {
  const section = agentPresentUiPrompt(definition, options);
  if (section === undefined) return systemPrompt;
  return `${systemPrompt}\n\n${section}`;
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
  return parsed.part.kind === UI_PART_KIND_ARTIFACT_REF || parsed.part.kind === UI_PART_KIND_CARD ? [parsed.part] : [];
}

/** True for a part that puts something on screen (an artifact or a card), as opposed to an error. */
export function isPresentedUiPart(part: UiPart): part is UiPartArtifactRef | UiPartCard {
  return part.kind === UI_PART_KIND_ARTIFACT_REF || part.kind === UI_PART_KIND_CARD;
}

/** The title shown with a presented artifact: the one given, else the manifest's, else a markdown program's first heading, else "Chat". */
function presentedTitle(given: unknown, manifest: Record<string, unknown>, program: string): string {
  if (typeof given === "string" && given.trim().length > 0) return given.trim();
  if (typeof manifest.title === "string" && manifest.title.trim().length > 0) return manifest.title.trim();
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(program)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : "Chat";
}

/** Characters of an HTML card kept when a session is replayed; most cards fit, so the agent can still edit them. */
export const REPLAY_PROGRAM_MAX = 12_000;

function replayUiPart(part: UiPartArtifactRef | UiPartCard): unknown {
  if (part.kind !== UI_PART_KIND_CARD || part.format !== "live.html" || part.program.length <= REPLAY_PROGRAM_MAX) return { type: "ui", ui: part };
  const note = `<!-- Replay kept the first ${REPLAY_PROGRAM_MAX} of ${part.program.length} characters. This card is incomplete here: to change it, write the whole card again. -->`;
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

function htmlCardManifestDeclaresNetwork(csp: HtmlCsp): boolean {
  return (csp.connectDomains?.length ?? 0) > 0 || (csp.resourceDomains?.length ?? 0) > 0
    || (csp.baseUriDomains?.length ?? 0) > 0 || (csp.frameDomains?.length ?? 0) > 0;
}

function publishErrorCode(error: ArtifactPublishError): string {
  if (error.code === "artifact.invalid_shape" && error.issues?.some((issue) => issue.message.includes("unknown library"))) {
    return "ui.unknown_library";
  }
  return error.code;
}

export type PresentArtifactInput = {
  db: import("better-sqlite3").Database;
  roots: readonly CatalogRoot[];
  projectRoot: string;
  key?: string;
  version?: number;
  title?: string;
  program?: string;
  manifest?: unknown;
  sessionId?: string;
  agentId?: string;
  presentedInMessage?: number;
  nowMs?: number;
  allowedKinds: readonly string[];
  consoleDeps: McpToolDeps;
};

export type PresentArtifactResult =
  | { ok: true; envelope: UiPartEnvelope }
  | { ok: false; code: string; message: string };

function toolFailure(code: string, message: string): PresentArtifactResult {
  return { ok: false, code, message };
}

function readScoped(
  db: import("better-sqlite3").Database,
  roots: readonly CatalogRoot[],
  ownerKey: string,
  id: string,
  projectRoot: string | undefined,
): { record?: ReturnType<typeof readArtifact>; missing: boolean; elsewhere: boolean } {
  try {
    return { record: readArtifact(db, ownerKey, id, projectRoot, roots), missing: false, elsewhere: false };
  } catch (error) {
    if (error instanceof ArtifactQueryError && (error.status === 404 || error.status === 409)) {
      return { missing: error.status === 404, elsewhere: error.status === 409 };
    }
    throw error;
  }
}

function sessionIsEval(db: PresentArtifactInput["db"], sessionId: string): boolean {
  try {
    const row = db.prepare(`SELECT source FROM agent_sessions WHERE session_id = ?`).get(sessionId) as
      | { source: string }
      | undefined;
    return row?.source === "eval";
  } catch {
    return true;
  }
}

function manifestRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export async function presentInline(input: PresentArtifactInput): Promise<PresentArtifactResult> {
  const program = input.program ?? "";
  const manifest = manifestRecord(input.manifest);
  if (program.trim().length === 0) return toolFailure("artifact.invalid_shape", "program is required");
  if (!manifest) return toolFailure("artifact.invalid_shape", "manifest is required");
  const kind = typeof manifest.kind === "string" ? manifest.kind : "";
  if (!kind) {
    return toolFailure("artifact.invalid_shape", `manifest.kind is required: one of ${input.allowedKinds.join(", ")}`);
  }
  if (!input.allowedKinds.includes(kind) || !isPresentableArtifactKind(kind)) {
    return toolFailure("ui.kind_not_granted", `This agent cannot present ${kind} artifacts: use one of ${input.allowedKinds.join(", ")}`);
  }
  const sessionId = input.sessionId?.trim() ?? "";
  const agentId = input.agentId?.trim() ?? "";
  if (!sessionId || !agentId) return toolFailure("ui.unavailable", "present_ui is not available");
  const nowMs = input.nowMs ?? Date.now();
  try {
    assertSessionArtifactCaps(input.db, sessionId, input.presentedInMessage ?? 1, nowMs);
    const evalSession = sessionIsEval(input.db, sessionId);
    const titleSource = presentedTitle(input.title, manifest, program);
    const title = titleSource.slice(0, ARTIFACT_TITLE_MAX_CHARS);
    const live = isLiveKind(kind);
    const published = await publishArtifact(input.db, {
      owner: { kind: "agent", agent: agentId },
      projectRoot: input.projectRoot,
      id: newSessionArtifactId(),
      kind,
      title,
      bytes: Buffer.from(program, "utf8"),
      ...(live ? { manifest: { ...manifest, program, kind } } : {}),
      publishSource: "api",
      source: { kind: "agent", sessionId },
      scope: "session",
      expiresAt: sessionArtifactExpiresAt(nowMs),
      ...(evalSession ? { hidden: true, ownerNamespace: "eval" as const } : {}),
      roots: input.roots,
    });
    const slash = published.key.lastIndexOf("/");
    const ownerKey = published.key.slice(0, slash);
    const id = published.key.slice(slash + 1);
    const params = new URLSearchParams();
    params.set("project_root", published.project_root);
    const hashPath = `/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}?${params.toString()}`;
    const part: UiPartArtifactRef = {
      v: UI_PART_SCHEMA_VERSION,
      kind: UI_PART_KIND_ARTIFACT_REF,
      key: published.key,
      title,
      fallback: { text: title, url: consoleUrl(input.consoleDeps, hashPath) },
    };
    return { ok: true, envelope: { type: "ui", ui: part } };
  } catch (error) {
    if (error instanceof ArtifactPublishError) {
      const detail = error.issues?.map((issue) => issue.message).filter(Boolean).slice(0, 5).join("; ");
      return toolFailure(error.code, detail && detail !== error.message ? `${error.message}: ${detail}` : error.message);
    }
    throw error;
  }
}

let cardLimiter = new SlidingWindowLimiter(SESSION_ARTIFACT_RATE_WINDOW_MS);

export function resetCardLimiterForTests(): void {
  cardLimiter = new SlidingWindowLimiter(SESSION_ARTIFACT_RATE_WINDOW_MS);
}

export type PresentCardInput = {
  projectRoot: string;
  sessionId: string;
  title?: string;
  program: string;
  manifest: unknown;
  presentedInMessage: number;
  allowedKinds: readonly string[];
  nowMs?: number;
};

/** Checks a card program and returns it as a ui part. Nothing is written: the card lives in the message. */
export async function presentCard(input: PresentCardInput): Promise<PresentArtifactResult> {
  const program = input.program;
  const manifest = manifestRecord(input.manifest);
  if (program.trim().length === 0) return toolFailure("artifact.invalid_shape", "program is required");
  if (!manifest) return toolFailure("artifact.invalid_shape", "manifest is required");
  const kind = typeof manifest.kind === "string" ? manifest.kind : "";
  if (!kind || !input.allowedKinds.includes(kind) || !isConversationCardKind(kind)) {
    return toolFailure("ui.kind_not_granted", `This agent cannot draw ${kind || "that"} cards. Kinds: ${input.allowedKinds.join(", ")}`);
  }
  if (Buffer.byteLength(program, "utf8") > CARD_PROGRAM_MAX_BYTES) {
    return toolFailure("artifact.too_large", `program is larger than ${CARD_PROGRAM_MAX_BYTES} bytes`);
  }
  if (input.presentedInMessage > SESSION_ARTIFACTS_PER_MESSAGE) {
    return toolFailure("ui.message_cap", `A reply can hold at most ${SESSION_ARTIFACTS_PER_MESSAGE} cards`);
  }
  const rate = cardLimiter.take(input.sessionId, SESSION_ARTIFACT_RATE_LIMIT, input.nowMs ?? Date.now());
  if (!rate.ok) return toolFailure("ui.rate_limited", `Too many cards. Try again in ${rate.retryAfterSec}s`);
  const titleSource = typeof input.title === "string" && input.title.trim().length > 0 ? input.title.trim() : "Card";
  const title = titleSource.slice(0, ARTIFACT_TITLE_MAX_CHARS);
  let library: UiPartCard["library"];
  let libraries: UiPartCard["libraries"];
  if (kind === "live.declarative") {
    const bindings = manifest.bindings;
    const actions = manifest.actions;
    if ((Array.isArray(bindings) && bindings.length > 0) || (Array.isArray(actions) && actions.length > 0)) {
      return toolFailure(
        "ui.card_display_only",
        "A card shows only what you write into it: set bindings to [] and leave out actions, and put the data in the program as literals",
      );
    }
    try {
      const live = validateLiveManifest({ ...manifest, bindings: [], program }, program);
      await assertLiveProgramAtPublish(input.projectRoot, live);
      library = { name: live.library.name, version: live.library.version };
    } catch (error) {
      if (error instanceof ArtifactPublishError) {
        const detail = error.issues?.map((issue) => issue.message).filter(Boolean).slice(0, 5).join("; ");
        return toolFailure(error.code, detail && detail !== error.message ? `${error.message}: ${detail}` : error.message);
      }
      throw error;
    }
  } else if (kind === "live.html") {
    const bindings = manifest.bindings;
    const actions = manifest.actions;
    const refresh = manifest.refresh;
    if ((Array.isArray(bindings) && bindings.length > 0) || (Array.isArray(actions) && actions.length > 0)
      || (refresh !== undefined && refresh !== null)) {
      return toolFailure(
        "ui.card_display_only",
        "An HTML card is display-only: leave out bindings, actions, refresh, and external csp origins; put data in the HTML and use vendored libraries only",
      );
    }
    if (typeof manifest.key === "string" && manifest.key.trim().length > 0) {
      return toolFailure("ui.card_display_only", "An HTML card cannot reference a saved artifact; write the HTML into program");
    }
    const { kind: _kind, ...rest } = manifest;
    try {
      const html = validateHtmlManifest({ ...rest, format: "html", bindings: [] }, { enforceEval: true });
      if (htmlCardManifestDeclaresNetwork(html.csp)) {
        return toolFailure(
          "ui.card_display_only",
          "An HTML card cannot declare network or external origins: omit csp or leave every list empty",
        );
      }
      await assertHtmlDocumentAtPublish(program, html.csp);
      libraries = html.libraries?.map((entry) => ({ name: entry.name, version: entry.version }));
    } catch (error) {
      if (error instanceof ArtifactPublishError) {
        const detail = error.issues?.map((issue) => issue.message).filter(Boolean).slice(0, 5).join("; ");
        const code = publishErrorCode(error);
        return toolFailure(code, detail && detail !== error.message ? `${error.message}: ${detail}` : error.message);
      }
      throw error;
    }
  }
  const part: UiPartCard = {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_CARD,
    title,
    format: kind,
    program,
    ...(library ? { library } : {}),
    ...(libraries && libraries.length > 0 ? { libraries } : {}),
    fallback: {
      text: kind === "static.markdown" ? program.slice(0, UI_PART_FALLBACK_TEXT_MAX_CHARS) : title,
      url: "",
    },
  };
  return { ok: true, envelope: { type: "ui", ui: part } };
}

export function presentArtifact(input: PresentArtifactInput): PresentArtifactResult {
  const key = typeof input.key === "string" ? input.key.trim() : "";
  const parts = key.includes("/") ? key.split("/") : [];
  const ownerKey = parts.length >= 2 ? parts.slice(0, -1).join("/") : "";
  const id = parts.length >= 2 ? parts[parts.length - 1]! : "";
  if (!ownerKey || !id || parseOwnerKey(ownerKey) === undefined) {
    return toolFailure("artifact.invalid_id", "Artifact key is not valid");
  }
  if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 1)) {
    return toolFailure("artifact.invalid_id", "Version must be a positive integer");
  }
  const scoped = readScoped(input.db, input.roots, ownerKey, id, input.projectRoot);
  if (!scoped.record) {
    const anywhere = readScoped(input.db, input.roots, ownerKey, id, undefined);
    if (anywhere.record || anywhere.elsewhere || scoped.elsewhere) {
      return toolFailure("ui.cross_project", "That artifact belongs to another project");
    }
    return toolFailure("artifact.not_found", "Artifact not found");
  }
  const record = scoped.record;
  const sessionRoot = input.roots.find(
    (root) =>
      storedProjectMatches(root.project_root, { path: input.projectRoot }) ||
      storedProjectMatches(root.path, { path: input.projectRoot }),
  );
  if (!storedProjectMatches(record.project.id, { id: sessionRoot?.project_root, path: input.projectRoot })) {
    return toolFailure("ui.cross_project", "That artifact belongs to another project");
  }
  if (!input.allowedKinds.includes(record.kind) || !isPresentableArtifactKind(record.kind)) {
    return toolFailure("ui.kind_not_granted", `This agent cannot present ${record.kind} artifacts`);
  }
  let version = input.version;
  if (version !== undefined) {
    if (version > record.version) return toolFailure("artifact.not_found", "That version does not exist");
    if (version < record.version) {
      const row = readArtifactVersionRow(input.db, artifactStorageKey(record.project.id, ownerKey, id), version);
      if (!row) return toolFailure("artifact.not_found", "That version does not exist");
    }
  }
  const titleSource = typeof input.title === "string" && input.title.trim().length > 0 ? input.title.trim() : record.title;
  const title = titleSource.slice(0, ARTIFACT_TITLE_MAX_CHARS) || "Artifact";
  const params = new URLSearchParams();
  params.set("project_root", record.project.id);
  if (version !== undefined) params.set("v", String(version));
  const hashPath = `/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}?${params.toString()}`;
  const part: UiPartArtifactRef = {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_ARTIFACT_REF,
    key: publicArtifactKey(ownerKey, id),
    ...(version !== undefined ? { version } : {}),
    title,
    fallback: { text: title, url: consoleUrl(input.consoleDeps, hashPath) },
  };
  return { ok: true, envelope: { type: "ui", ui: part } };
}

function presentError(code: string, message: string) {
  const payload = { code, message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true as const,
  };
}

export type PresentUiTool = {
  name: typeof PRESENT_UI_TOOL_NAME;
  label: string;
  description: string;
  parameters: ReturnType<typeof presentUiParameterSchema>;
  execute(toolCallId: string, params: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: true;
  }>;
};

function presentUiParameterSchema() {
  return Type.Object({
    key: Type.Optional(Type.String({ description: "Artifact key (owner/id) in this project." })),
    version: Type.Optional(Type.Integer({ minimum: 1, description: "Version to show. Omit to show the current version." })),
    title: Type.Optional(Type.String({ description: "Title shown with the artifact. Defaults to the artifact title." })),
    program: Type.Optional(Type.String({ description: "Program or text to save as a session artifact. Requires manifest." })),
    manifest: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Publish manifest, including kind. Required with program." })),
  });
}

function presentCardParameterSchema() {
  return Type.Object({
    title: Type.Optional(Type.String({ description: "Short title shown above the card." })),
    program: Type.String({ description: "The card program: live.declarative, markdown text (static.markdown), or a full HTML document (live.html)." }),
    manifest: Type.Record(Type.String(), Type.Unknown(), {
      description: "Manifest with kind. live.declarative: format, library, bindings: []. live.html: format html, optional libraries ({name, version}), empty csp. static.markdown: kind only.",
    }),
  });
}

export function createPresentUiTool(options: {
  kinds: readonly string[];
  projectRoot: string;
  /** "conversation" offers cards only (program and manifest); "artifacts" also shows saved artifacts by key. */
  persistence?: "conversation" | "artifacts";
  present: (input: {
    key?: string;
    version?: number;
    title?: string;
    program?: string;
    manifest?: unknown;
    presentedInMessage: number;
  }) => Promise<PresentArtifactResult>;
}): PresentUiTool {
  const conversation = (options.persistence ?? "artifacts") === "conversation";
  return {
    name: PRESENT_UI_TOOL_NAME,
    label: conversation ? "Draw card" : "Present artifact",
    description: conversation
      ? `Draw a card in this conversation. Kinds: ${options.kinds.join(", ")}. Pass program, manifest (with kind) and a title. The card shows only what the program contains. To change a card, call again with the full updated program. An invalid program is refused with the reason.`
      : `Show an artifact from this project in the conversation. Kinds: ${options.kinds.join(", ")}. Pass key, or program and manifest for a one-off. Pass version only to pin one version. The result is a ui part. A missing key, a key from another project, or an invalid program is refused.`,
    parameters: (conversation ? presentCardParameterSchema() : presentUiParameterSchema()) as ReturnType<typeof presentUiParameterSchema>,
    execute: async (_toolCallId, params) => {
      const record = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      const key = record.key;
      const version = record.version;
      const title = record.title;
      const program = record.program;
      const manifest = record.manifest;
      const hasProgram = typeof program === "string";
      const hasKey = typeof key === "string" && key.trim().length > 0;
      if (conversation && hasKey) {
        return presentError("ui.key_needs_artifacts", "This agent draws cards in the conversation and cannot show saved artifacts. Pass program and manifest instead");
      }
      if (hasProgram === hasKey) return presentError("artifact.invalid_shape", conversation ? "Pass program and manifest" : "Pass key, or program and manifest, not both");
      if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version))) {
        return presentError("artifact.invalid_id", "Version must be a positive integer");
      }
      if (title !== undefined && typeof title !== "string") return presentError("artifact.invalid_id", "Title must be text");
      if (hasProgram && (manifest === undefined || manifest === null || typeof manifest !== "object" || Array.isArray(manifest))) {
        return presentError("artifact.invalid_shape", "manifest is required");
      }
      try {
        const result = await options.present({
          ...(hasKey ? { key: key as string } : {}),
          ...(typeof version === "number" ? { version } : {}),
          ...(typeof title === "string" ? { title } : {}),
          ...(hasProgram ? { program, manifest } : {}),
          presentedInMessage: 0,
        });
        if (!result.ok) return presentError(result.code, result.message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.envelope) }],
          details: result.envelope as unknown as Record<string, unknown>,
        };
      } catch {
        return presentError("ui.unavailable", "present_ui is not available");
      }
    },
  };
}
