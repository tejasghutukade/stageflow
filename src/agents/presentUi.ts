import type { AgentDefinition } from "../config/loadAgent.js";
import { ARTIFACT_TITLE_MAX_CHARS } from "../artifacts/limits.js";
import { artifactStorageKey, parseOwnerKey, publicArtifactKey } from "../artifacts/keys.js";
import { isPresentableArtifactKind } from "../artifacts/kinds.js";
import { storedProjectMatches } from "../artifacts/projectIdentity.js";
import { ArtifactQueryError, readArtifact } from "../artifacts/query.js";
import { readArtifactVersionRow } from "../artifacts/versions.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { consoleUrl } from "../mcp/writeTarget.js";
import type { McpToolDeps } from "../mcp/deps.js";
import {
  parseUiPartEnvelope,
  UI_PART_KIND_ARTIFACT_REF,
  UI_PART_SCHEMA_VERSION,
  type UiPartArtifactRef,
  type UiPartEnvelope,
} from "../artifacts/uiPart.js";
import { Type } from "typebox";

export const PRESENT_UI_TOOL_NAME = "present_ui";

export const AGENT_PRESENT_UI_SENTENCE =
  "You can place an artifact from this project into the conversation with present_ui. Pass its key. Pass version only when the person should see that version. The chat shows the artifact; do not paste its body into the reply.";

export function agentHoldsPresentUi(definition: Pick<AgentDefinition, "ui">): boolean {
  return definition.ui?.present === true;
}

export function agentPresentUiPrompt(definition: Pick<AgentDefinition, "ui">): string | undefined {
  if (!agentHoldsPresentUi(definition)) return undefined;
  const kinds = definition.ui.kinds.join(", ");
  return ["# Showing artifacts in chat", "", `${AGENT_PRESENT_UI_SENTENCE} Kinds you may present: ${kinds}.`].join("\n");
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
  return parsed.ok ? [parsed.part] : [];
}

/** Replay text keeps the structured ui envelope beside the reply, so a restored session is not only the fallback sentence. */
export function messageReplayText(message: { text: string; parts?: readonly UiPartArtifactRef[] }): string {
  const text = message.text.trim();
  const ui = (message.parts ?? []).map((part) => JSON.stringify({ type: "ui", ui: part })).join("\n");
  if (!ui) return text;
  return text ? `${text}\n${ui}` : ui;
}

export type PresentArtifactInput = {
  db: import("better-sqlite3").Database;
  roots: readonly CatalogRoot[];
  projectRoot: string;
  key: string;
  version?: number;
  title?: string;
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
    key: Type.String({ description: "Artifact key (owner/id) in this project." }),
    version: Type.Optional(Type.Integer({ minimum: 1, description: "Version to show. Omit to show the current version." })),
    title: Type.Optional(Type.String({ description: "Title shown with the artifact. Defaults to the artifact title." })),
  });
}

export function createPresentUiTool(options: {
  kinds: readonly string[];
  projectRoot: string;
  present: (input: { key: string; version?: number; title?: string }) => Promise<PresentArtifactResult>;
}): PresentUiTool {
  return {
    name: PRESENT_UI_TOOL_NAME,
    label: "Present artifact",
    description: `Show an artifact from this project in the conversation. Kinds: ${options.kinds.join(", ")}. Pass key, and version only to pin one version. The result is a ui part. A missing key or a key from another project is refused.`,
    parameters: presentUiParameterSchema(),
    execute: async (_toolCallId, params) => {
      const record = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      const key = record.key;
      const version = record.version;
      const title = record.title;
      if (typeof key !== "string" || key.trim().length === 0) return presentError("artifact.invalid_id", "Artifact key is not valid");
      if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version))) {
        return presentError("artifact.invalid_id", "Version must be a positive integer");
      }
      if (title !== undefined && typeof title !== "string") return presentError("artifact.invalid_id", "Title must be text");
      try {
        const result = await options.present({
          key,
          ...(typeof version === "number" ? { version } : {}),
          ...(typeof title === "string" ? { title } : {}),
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
