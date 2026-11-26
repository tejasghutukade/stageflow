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
  parseUiPartEnvelope,
  UI_PART_KIND_ARTIFACT_REF,
  UI_PART_SCHEMA_VERSION,
  type UiPart,
  type UiPartArtifactRef,
  type UiPartEnvelope,
} from "../artifacts/uiPart.js";
import { Type } from "typebox";
import { declarativePromptSection, htmlPromptSection } from "../artifacts/livePrompt.js";

export const PRESENT_UI_TOOL_NAME = "present_ui";

export const AGENT_PRESENT_UI_SENTENCE =
  "You can place an artifact from this project into the conversation with present_ui. Pass its key, or pass program and manifest to show a one-off chart or table without publishing first. Pass version only when the person should see that version. The chat shows the artifact; do not paste its body into the reply. If present_ui returns a validation error, fix the program and call it again.";

export function agentHoldsPresentUi(definition: Pick<AgentDefinition, "ui">): boolean {
  return definition.ui?.present === true;
}

export function agentPresentUiPrompt(definition: Pick<AgentDefinition, "ui">): string | undefined {
  if (!agentHoldsPresentUi(definition)) return undefined;
  const kinds = definition.ui.kinds.join(", ");
  const sections = ["# Showing artifacts in chat", "", `${AGENT_PRESENT_UI_SENTENCE} Kinds you may present: ${kinds}.`];
  if (definition.ui.kinds.includes("live.declarative")) sections.push("", declarativePromptSection());
  if (definition.ui.kinds.includes("live.html")) sections.push("", htmlPromptSection());
  return sections.join("\n");
}

export function appendAgentPresentUiPrompt(systemPrompt: string, definition: Pick<AgentDefinition, "ui">): string {
  const section = agentPresentUiPrompt(definition);
  if (section === undefined) return systemPrompt;
  return `${systemPrompt}\n\n${section}`;
}

export function uiPartsFromToolOutput(tool: string, output: string): UiPartArtifactRef[] {
  if (tool !== PRESENT_UI_TOOL_NAME) return [];
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    return [];
  }
  const parsed = parseUiPartEnvelope(value);
  return parsed.ok && parsed.part.kind === UI_PART_KIND_ARTIFACT_REF ? [parsed.part] : [];
}

/** Replay text keeps the structured ui envelope beside the reply, so a restored session is not only the fallback sentence. */
export function messageReplayText(message: { text: string; parts?: readonly UiPart[] }): string {
  const text = message.text.trim();
  const ui = (message.parts ?? [])
    .filter((part) => part.kind === UI_PART_KIND_ARTIFACT_REF)
    .map((part) => JSON.stringify({ type: "ui", ui: part }))
    .join("\n");
  if (!ui) return text;
  return text ? `${text}\n${ui}` : ui;
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
  if (!kind || !input.allowedKinds.includes(kind) || !isPresentableArtifactKind(kind)) {
    return toolFailure("ui.kind_not_granted", `This agent cannot present ${kind || "that"} artifacts`);
  }
  const sessionId = input.sessionId?.trim() ?? "";
  const agentId = input.agentId?.trim() ?? "";
  if (!sessionId || !agentId) return toolFailure("ui.unavailable", "present_ui is not available");
  const nowMs = input.nowMs ?? Date.now();
  try {
    assertSessionArtifactCaps(input.db, sessionId, input.presentedInMessage ?? 1, nowMs);
    const evalSession = sessionIsEval(input.db, sessionId);
    const titleSource = typeof input.title === "string" && input.title.trim().length > 0 ? input.title.trim() : "Chat";
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

export function createPresentUiTool(options: {
  kinds: readonly string[];
  projectRoot: string;
  present: (input: {
    key?: string;
    version?: number;
    title?: string;
    program?: string;
    manifest?: unknown;
    presentedInMessage: number;
  }) => Promise<PresentArtifactResult>;
}): PresentUiTool {
  return {
    name: PRESENT_UI_TOOL_NAME,
    label: "Present artifact",
    description: `Show an artifact from this project in the conversation. Kinds: ${options.kinds.join(", ")}. Pass key, or program and manifest for a one-off. Pass version only to pin one version. The result is a ui part. A missing key, a key from another project, or an invalid program is refused.`,
    parameters: presentUiParameterSchema(),
    execute: async (_toolCallId, params) => {
      const record = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      const key = record.key;
      const version = record.version;
      const title = record.title;
      const program = record.program;
      const manifest = record.manifest;
      const hasProgram = typeof program === "string";
      const hasKey = typeof key === "string" && key.trim().length > 0;
      if (hasProgram === hasKey) return presentError("artifact.invalid_shape", "Pass key, or program and manifest, not both");
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
