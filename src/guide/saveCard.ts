import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { GUIDE_OWNER_KEY } from "../artifacts/keys.js";
import { Type } from "typebox";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import { LIBRARY_NAME, LIBRARY_VERSION, OPENUI_LANG_FORMAT } from "../artifacts/library/index.js";
import { ArtifactPublishError } from "../artifacts/limits.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";
import { publishArtifact } from "../artifacts/publish.js";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION, type UiPartArtifactRef, type UiPartEnvelope } from "../artifacts/uiPart.js";
import type { UiPartCard } from "../artifacts/uiPartCard.js";
import type { McpToolDeps } from "../mcp/deps.js";
import { consoleUrl } from "../mcp/writeTarget.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";
import { guideContextOf } from "../operatorAgent/profiles/guideConfirm.js";
import type { OperatorAgentTool, OperatorAgentToolResult } from "../operatorAgent/types.js";
import { readPresentUiCard } from "../genui/parts.js";
import { readGuideThread } from "./threadStore.js";

export const SAVE_CARD_TOOL_NAME = "save_card";
export const GUIDE_SAVE_CARD_TOOL_NAMES = [SAVE_CARD_TOOL_NAME] as const;

const TITLE_MAX = 120;

function failure(code: string, message: string): OperatorAgentToolResult {
  return { ok: false, content: { code, message }, error: code };
}

/**
 * The card to save from this thread, newest first: the present_ui call with that id, else the card with that title,
 * else (no id given) the latest card. The model rarely sees its own tool call ids, so people say "save this chart".
 */
export function findThreadCard(threadId: string, cardId: string): { id: string; card: UiPartCard } | null {
  const thread = readGuideThread(threadId);
  if (!thread) return null;
  const cards: Array<{ id: string; card: UiPartCard }> = [];
  for (const message of [...thread.messages].reverse()) {
    for (const part of [...(message.parts ?? [])].reverse()) {
      if (part.type !== "tool" || part.name !== "present_ui" || part.status !== "complete") continue;
      const card = readPresentUiCard(part.result);
      if (card) cards.push({ id: part.id, card });
    }
  }
  if (!cardId) return cards[0] ?? null;
  const wanted = cardId.toLowerCase();
  return cards.find((entry) => entry.id === cardId) ?? cards.find((entry) => entry.card.title.trim().toLowerCase() === wanted) ?? null;
}

function manifestFor(card: UiPartCard): Record<string, unknown> | undefined {
  if (card.format === "live.declarative") {
    return {
      format: OPENUI_LANG_FORMAT,
      library: card.library ?? { name: LIBRARY_NAME, version: LIBRARY_VERSION },
      bindings: [],
    };
  }
  if (card.format === "live.html") {
    return {
      format: "html",
      bindings: [],
      ...(card.libraries && card.libraries.length > 0 ? { libraries: card.libraries } : {}),
    };
  }
  return undefined;
}

/** One artifact per card: saving the same card again returns the artifact it already made. */
function cardArtifactId(threadId: string, cardId: string): string {
  return `card_${createHash("sha256").update(`${threadId}\u0000${cardId}`).digest("hex").slice(0, 16)}`;
}

type SavedRow = { id: string; current_version: number; project_root_id: string; title: string; deleted_at: string | null };

function savedCardRow(db: Database.Database, id: string): SavedRow | undefined {
  return db
    .prepare(`SELECT id, current_version, project_root_id, title, deleted_at FROM artifacts WHERE owner_kind = 'guide' AND id = ? ORDER BY deleted_at IS NULL DESC LIMIT 1`)
    .get(id) as SavedRow | undefined;
}

function artifactRef(deps: McpToolDeps, key: string, version: number, title: string, url: string): OperatorAgentToolResult {
  const part: UiPartArtifactRef = {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_ARTIFACT_REF,
    key,
    version,
    title,
    fallback: { text: "Open in Artifacts", url: consoleUrl(deps, url) },
  };
  const envelope: UiPartEnvelope = { type: "ui", ui: part };
  return { ok: true, content: envelope };
}

export function createGuideSaveCardTool(deps: McpToolDeps): OperatorAgentTool {
  return {
    name: SAVE_CARD_TOOL_NAME,
    description:
      "Save a card already drawn in this chat as a project artifact. Leave card_id out to save the latest card, or pass the card's title (or the present_ui call id) to pick an earlier one. Optional title. Saving the same card again returns the artifact it already made; it never overwrites another artifact and needs no confirmation. The saved program is the card as stored in this chat, where secrets are redacted. Returns an artifact reference.",
    parameters: Type.Object(
      {
        card_id: Type.Optional(Type.String({ description: "The present_ui call id, or the card's title. Leave it out to save the latest card in this chat." })),
        title: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    handler: async (args, ctx) => {
      const requested = typeof args.card_id === "string" ? args.card_id.trim() : "";
      if (args.title !== undefined && typeof args.title !== "string") {
        return failure("artifact.invalid_id", "Title must be text");
      }
      const threadId = guideContextOf(ctx.getContext()).threadId?.trim();
      if (!threadId) return failure("guide.card_not_found", "This chat is not attached to a thread");
      const thread = readGuideThread(threadId);
      if (!thread) return failure("guide.card_not_found", "This chat has no saved thread");
      const found = findThreadCard(threadId, requested);
      if (!found) {
        return failure(
          "guide.card_not_found",
          requested
            ? "No card with that id or title in this chat yet. A card can be saved once it has been shown, in a later message. Leave card_id out to save the latest card."
            : "There is no card in this chat yet. A card can be saved once it has been shown, in a later message.",
        );
      }
      const db = sqliteConnectionFromStore(deps.store);
      if (!db) return failure("artifact.store_unavailable", "Artifact index is unavailable");
      const { id: cardId, card } = found;
      const titleSource = typeof args.title === "string" && args.title.trim().length > 0 ? args.title.trim() : card.title;
      const title = titleSource.slice(0, TITLE_MAX) || "Card";
      const projectRoot = defaultAgentProjectRoot(deps.projectRoot ?? deps.cwd);
      const manifest = manifestFor(card);
      const stableId = cardArtifactId(threadId, cardId);
      const existing = savedCardRow(db, stableId);
      if (existing && existing.deleted_at === null) {
        const params = new URLSearchParams({ project_root: existing.project_root_id });
        return artifactRef(deps, `${GUIDE_OWNER_KEY}/${existing.id}`, existing.current_version, existing.title, `/artifacts/${encodeURIComponent(GUIDE_OWNER_KEY)}/${encodeURIComponent(existing.id)}?${params.toString()}`);
      }
      // A deleted earlier save keeps its id reserved; a new save gets a fresh one.
      const id = existing ? `card_${randomBytes(8).toString("hex")}` : stableId;
      try {
        const published = await publishArtifact(db, {
          owner: { kind: "guide" },
          projectRoot,
          id,
          kind: card.format,
          title,
          bytes: Buffer.from(card.program, "utf8"),
          ...(manifest ? { manifest } : {}),
          publishSource: "api",
          source: { kind: "guide", sessionId: threadId },
          roots: await catalogRootsForArtifacts(deps.store),
        });
        return artifactRef(deps, published.key, published.version, title, published.url);
      } catch (error) {
        if (error instanceof ArtifactPublishError) return failure(error.code, error.message);
        throw error;
      }
    },
  };
}
