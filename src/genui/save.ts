import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { LIBRARY_NAME, LIBRARY_VERSION, OPENUI_LANG_FORMAT } from "../artifacts/library/index.js";
import { ArtifactPublishError } from "../artifacts/limits.js";
import { publishArtifact } from "../artifacts/publish.js";
import { artifactOwnerKey, ownerMatchSql, type ArtifactOwner } from "../artifacts/owners.js";
import { sessionArtifactExpiresAt } from "../artifacts/sessionScope.js";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION, type UiPartArtifactRef, type UiPartEnvelope } from "../artifacts/uiPart.js";
import type { UiPartCard } from "../artifacts/uiPartCard.js";
import { CardsUnavailableError, findCard } from "./cards.js";
import { genUiKind } from "./kinds.js";
import { sessionIsEval } from "./present.js";
import type { Surface } from "./surface.js";
import type { GenUiToolResult } from "./tools.js";

const TITLE_MAX = 120;

function failure(code: string, message: string): GenUiToolResult {
  return { ok: false, code, message };
}

/** The publish manifest for a saved card, through its kind's `toArtifactManifest`; undefined for static kinds. */
export function cardArtifactManifest(card: UiPartCard): Record<string, unknown> | undefined {
  const manifest: Record<string, unknown> =
    card.format === "live.declarative"
      ? { kind: card.format, format: OPENUI_LANG_FORMAT, library: card.library ?? { name: LIBRARY_NAME, version: LIBRARY_VERSION }, bindings: [] }
      : card.format === "live.html"
        ? { kind: card.format, format: "html", bindings: [], ...(card.libraries && card.libraries.length > 0 ? { libraries: card.libraries } : {}) }
        : { kind: card.format };
  return genUiKind(card.format)?.toArtifactManifest(manifest, card.program);
}

/** One artifact per card: saving the same card again returns the artifact it already made. `generation` moves past deleted saves. */
export function cardArtifactId(surfaceId: string, cardId: string, generation = 0): string {
  const seed = generation === 0 ? `${surfaceId}\u0000${cardId}` : `${surfaceId}\u0000${cardId}\u0000${generation}`;
  return `card_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/** Deleted or expired saves stay reserved; past this many, a save gets a random id. */
const CARD_ID_GENERATIONS = 16;

type SavedRow = { id: string; current_version: number; project_root_id: string; title: string; deleted_at: string | null; status: string | null };

function savedCardRow(db: Database.Database, owner: ArtifactOwner, id: string): SavedRow | undefined {
  const columns = `SELECT id, current_version, project_root_id, title, deleted_at, status FROM artifacts`;
  const order = `ORDER BY deleted_at IS NULL DESC LIMIT 1`;
  const match = ownerMatchSql(owner);
  return db.prepare(`${columns} WHERE ${match.sql} AND id = @id ${order}`).get({ ...match.params, id }) as SavedRow | undefined;
}

function hashPath(ownerKey: string, id: string, projectId: string): string {
  const params = new URLSearchParams({ project_root: projectId });
  return `/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}?${params.toString()}`;
}

function artifactRef(key: string, version: number, title: string, url: string): GenUiToolResult {
  const part: UiPartArtifactRef = {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_ARTIFACT_REF,
    key,
    version,
    title,
    fallback: { text: "Open in Artifacts", url },
  };
  const envelope: UiPartEnvelope = { type: "ui", ui: part };
  return { ok: true, value: envelope as unknown as Record<string, unknown> };
}

/** A stage's owner is applied by its publish port, so a stage surface has none of its own to save under. */
function ownerOf(surface: Surface): ArtifactOwner | undefined {
  return surface.owner.kind === "stage" ? undefined : surface.owner;
}

/**
 * save_card: keep a card this conversation already showed as an artifact owned by the surface's owner. The program is
 * the card as the conversation stored it. A visitor session's save stays in that conversation (session scope).
 */
export async function saveCard(surface: Surface, args: { ref?: string; title?: unknown }): Promise<GenUiToolResult> {
  if (args.title !== undefined && typeof args.title !== "string") return failure("artifact.invalid_id", "Title must be text");
  const source = surface.cards;
  const owner = ownerOf(surface);
  if (!source || !owner) return failure("ui.unavailable", "save_card is not available");
  const requested = args.ref?.trim() ?? "";
  let found;
  try {
    found = await findCard(source, requested);
  } catch (error) {
    if (error instanceof CardsUnavailableError) return failure(source.notFoundCode, error.message);
    throw error;
  }
  if (!found) {
    return failure(
      source.notFoundCode,
      requested
        ? "No card with that id or title in this chat yet. A card can be saved once it has been shown, in a later message. Leave card_id out to save the latest card."
        : "There is no card in this chat yet. A card can be saved once it has been shown, in a later message.",
    );
  }
  const store = await surface.artifacts?.();
  if (!store) return failure("artifact.store_unavailable", "Artifact index is unavailable");
  const { db } = store;
  const { id: cardId, card } = found;
  const titleSource = typeof args.title === "string" && args.title.trim().length > 0 ? args.title.trim() : card.title;
  const title = titleSource.slice(0, TITLE_MAX) || "Card";
  const ownerKey = artifactOwnerKey(owner);
  // A deleted or expired earlier save keeps its id reserved; the next save takes the next stable id.
  let id: string | undefined;
  for (let generation = 0; generation < CARD_ID_GENERATIONS && id === undefined; generation += 1) {
    const candidate = cardArtifactId(surface.id, cardId, generation);
    const existing = savedCardRow(db, owner, candidate);
    if (!existing) id = candidate;
    else if (existing.deleted_at === null && (existing.status ?? "available") === "available") {
      return artifactRef(`${ownerKey}/${existing.id}`, existing.current_version, existing.title, store.consoleUrl(hashPath(ownerKey, existing.id, existing.project_root_id)));
    }
  }
  id ??= `card_${randomBytes(8).toString("hex")}`;
  const manifest = cardArtifactManifest(card);
  try {
    const published = await publishArtifact(db, {
      owner,
      projectRoot: surface.projectRoot,
      id,
      kind: card.format,
      title,
      bytes: Buffer.from(card.program, "utf8"),
      ...(manifest ? { manifest } : {}),
      publishSource: "api",
      source: { kind: owner.kind, sessionId: surface.id },
      ...(surface.policy.visitorSession ? { scope: "session" as const, expiresAt: sessionArtifactExpiresAt(Date.now()) } : {}),
      ...(owner.kind === "agent" && sessionIsEval(db, surface.id) ? { hidden: true, ownerNamespace: "eval" as const } : {}),
      roots: store.roots,
    });
    return artifactRef(published.key, published.version, title, store.consoleUrl(published.url));
  } catch (error) {
    if (error instanceof ArtifactPublishError) return failure(error.code, error.message);
    throw error;
  }
}
