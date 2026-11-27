import type Database from "better-sqlite3";
import { ARTIFACT_TITLE_MAX_CHARS, ArtifactPublishError } from "../artifacts/limits.js";
import { artifactStorageKey, publicArtifactKey } from "../artifacts/keys.js";
import { parseOwnerKey } from "../artifacts/owners.js";
import { storedProjectMatches } from "../artifacts/projectIdentity.js";
import { publishArtifact } from "../artifacts/publish.js";
import { ArtifactQueryError, readArtifact } from "../artifacts/query.js";
import {
  assertSessionArtifactCaps,
  newSessionArtifactId,
  SESSION_ARTIFACTS_PER_MESSAGE,
  sessionArtifactExpiresAt,
} from "../artifacts/sessionScope.js";
import {
  UI_PART_FALLBACK_TEXT_MAX_CHARS,
  UI_PART_KIND_ARTIFACT_REF,
  UI_PART_KIND_CARD,
  UI_PART_SCHEMA_VERSION,
  type UiPartArtifactRef,
  type UiPartCard,
  type UiPartEnvelope,
} from "../artifacts/uiPart.js";
import { readArtifactVersionRow } from "../artifacts/versions.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { takeCardRate } from "./budget.js";
import { genUiKind } from "./kinds.js";
import { assertGenUiSize, validateGenUi } from "./validate.js";

export type PresentArtifactInput = {
  db: Database.Database;
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
  /** Console link for a hash path (`/artifacts/...`), as the Host serves it. */
  consoleUrl: (hashPath: string) => string;
};

export type PresentArtifactResult =
  | { ok: true; envelope: UiPartEnvelope }
  | { ok: false; code: string; message: string };

function toolFailure(code: string, message: string): PresentArtifactResult {
  return { ok: false, code, message };
}

/** Same code as publish, except an unknown vendored library, which present_ui names `ui.unknown_library` on every surface. */
function presentErrorCode(error: ArtifactPublishError): string {
  if (error.code === "artifact.invalid_shape" && error.issues?.some((issue) => issue.message.includes("unknown library"))) {
    return "ui.unknown_library";
  }
  return error.code;
}

function publishFailure(error: ArtifactPublishError): PresentArtifactResult {
  const detail = error.issues?.map((issue) => issue.message).filter(Boolean).slice(0, 5).join("; ");
  return toolFailure(presentErrorCode(error), detail && detail !== error.message ? `${error.message}: ${detail}` : error.message);
}

function manifestRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The title of a card or one-off program: the one given, else the manifest's, else a markdown first heading, else "Card"; cut to the title limit. */
export function presentedTitle(given: unknown, manifest: Record<string, unknown>, program: string): string {
  return titleText(given, manifest, program).slice(0, ARTIFACT_TITLE_MAX_CHARS);
}

function titleText(given: unknown, manifest: Record<string, unknown>, program: string): string {
  if (typeof given === "string" && given.trim().length > 0) return given.trim();
  if (typeof manifest.title === "string" && manifest.title.trim().length > 0) return manifest.title.trim();
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(program)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : "Card";
}

function kindRequired(allowedKinds: readonly string[]): PresentArtifactResult {
  return toolFailure("artifact.invalid_shape", `manifest.kind is required: one of ${allowedKinds.join(", ")}`);
}

function readScoped(
  db: Database.Database,
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

export function sessionIsEval(db: Database.Database, sessionId: string): boolean {
  try {
    const row = db.prepare(`SELECT source FROM agent_sessions WHERE session_id = ?`).get(sessionId) as
      | { source: string }
      | undefined;
    return row?.source === "eval";
  } catch {
    return true;
  }
}

/** Publishes a one-off program as a session artifact (`ui.persistence: artifacts`) and returns a ref to it. */
export async function presentInline(input: PresentArtifactInput): Promise<PresentArtifactResult> {
  const program = input.program ?? "";
  const manifest = manifestRecord(input.manifest);
  if (program.trim().length === 0) return toolFailure("artifact.invalid_shape", "program is required");
  if (!manifest) return toolFailure("artifact.invalid_shape", "manifest is required");
  const kind = typeof manifest.kind === "string" ? manifest.kind : "";
  if (!kind) return kindRequired(input.allowedKinds);
  const entry = genUiKind(kind);
  if (!input.allowedKinds.includes(kind) || !entry?.presentable) {
    return toolFailure("ui.kind_not_granted", `This agent cannot present ${kind} artifacts: use one of ${input.allowedKinds.join(", ")}`);
  }
  const sessionId = input.sessionId?.trim() ?? "";
  const agentId = input.agentId?.trim() ?? "";
  if (!sessionId || !agentId) return toolFailure("ui.unavailable", "present_ui is not available");
  const nowMs = input.nowMs ?? Date.now();
  try {
    assertSessionArtifactCaps(input.db, sessionId, input.presentedInMessage ?? 1, nowMs);
    const evalSession = sessionIsEval(input.db, sessionId);
    const title = presentedTitle(input.title, manifest, program);
    const artifactManifest = entry.toArtifactManifest(manifest, program);
    const published = await publishArtifact(input.db, {
      owner: { kind: "agent", agent: agentId },
      projectRoot: input.projectRoot,
      id: newSessionArtifactId(),
      kind,
      title,
      bytes: Buffer.from(program, "utf8"),
      ...(artifactManifest ? { manifest: artifactManifest } : {}),
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
      fallback: { text: title, url: input.consoleUrl(hashPath) },
    };
    return { ok: true, envelope: { type: "ui", ui: part } };
  } catch (error) {
    if (error instanceof ArtifactPublishError) return publishFailure(error);
    throw error;
  }
}

export type PresentCardInput = {
  projectRoot: string;
  /** Rate-limit key of the surface (`surfaceKey`). */
  surfaceKey: string;
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
  if (!kind) return kindRequired(input.allowedKinds);
  if (!input.allowedKinds.includes(kind) || !genUiKind(kind)?.canBeCard) {
    return toolFailure("ui.kind_not_granted", `This agent cannot draw ${kind} cards. Kinds: ${input.allowedKinds.join(", ")}`);
  }
  try {
    assertGenUiSize(kind, Buffer.byteLength(program, "utf8"), "card");
  } catch (error) {
    if (error instanceof ArtifactPublishError) return publishFailure(error);
    throw error;
  }
  if (input.presentedInMessage > SESSION_ARTIFACTS_PER_MESSAGE) {
    return toolFailure("ui.message_cap", `A reply can hold at most ${SESSION_ARTIFACTS_PER_MESSAGE} cards`);
  }
  const rate = takeCardRate(input.surfaceKey, input.nowMs ?? Date.now());
  if (!rate.ok) return toolFailure("ui.rate_limited", `Too many cards. Try again in ${rate.retryAfterSec}s`);
  const title = presentedTitle(input.title, manifest, program);
  let library: UiPartCard["library"];
  let libraries: UiPartCard["libraries"];
  try {
    const { content } = await validateGenUi({ kind, manifest, program, mode: "card", projectRoot: input.projectRoot });
    if (content.live) library = { name: content.live.library.name, version: content.live.library.version };
    libraries = content.html?.libraries?.map((entry) => ({ name: entry.name, version: entry.version }));
  } catch (error) {
    if (error instanceof ArtifactPublishError) return publishFailure(error);
    throw error;
  }
  const part: UiPartCard = {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_CARD,
    title,
    format: kind as UiPartCard["format"],
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

/** Shows a saved artifact of this project by key. */
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
  if (!input.allowedKinds.includes(record.kind) || !genUiKind(record.kind)?.presentable) {
    return toolFailure("ui.kind_not_granted", `This agent cannot present ${record.kind} artifacts`);
  }
  const version = input.version;
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
    fallback: { text: title, url: input.consoleUrl(hashPath) },
  };
  return { ok: true, envelope: { type: "ui", ui: part } };
}
