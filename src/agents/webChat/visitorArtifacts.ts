import { isUtf8 } from "node:buffer";
import type Database from "better-sqlite3";
import { contentTooLarge } from "../../artifacts/content.js";
import { ARTIFACT_ID_PATTERN } from "../../artifacts/keys.js";
import { ownerKeyFromRow } from "../../artifacts/owners.js";
import { parseStoredHtmlManifest } from "../../artifacts/htmlManifest.js";
import { parseStoredLiveManifest } from "../../artifacts/manifest.js";
import { readArtifactSnapshots } from "../../artifacts/refresh.js";
import { parseArtifactShowKey } from "../../artifacts/showKey.js";
import { readStoredArtifactFile } from "../../artifacts/store.js";
import type { UiPartArtifactRef } from "../../artifacts/uiPartArtifactRef.js";
import { artifactVersionKind, readArtifactVersionRow } from "../../artifacts/versions.js";

/** What the public chat page needs to draw one artifact. No paths, projects, owners, or storage keys. */
export type VisitorArtifactView = {
  kind: string;
  title: string;
  version: number;
  text: string | null;
  contentType?: string;
  format?: string;
  library?: { name: string; version: string };
  libraries?: Array<{ name: string; version: string }>;
  bindings?: Array<{ id: string; function: string; args: Record<string, unknown> }>;
  snapshots?: Array<{ binding_id: string; value: unknown; fetched_at: string; status: string }>;
};

type OwnedRow = {
  key: string;
  id: string;
  title: string;
  kind: string;
  current_version: number;
  status: string;
  expires_at: string | null;
  owner_kind: string;
  owner_agent: string | null;
  owner_pipeline: string | null;
  owner_stage: string | null;
  source_session_id: string | null;
};

function pastExpiry(expiresAt: string | null, nowIso: string): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  if (Number.isFinite(at) && Number.isFinite(now)) return at <= now;
  return expiresAt <= nowIso;
}

function publicKeyOf(row: OwnedRow): string {
  return `${ownerKeyFromRow(row)}/${row.id}`;
}

function ownedRows(db: Database.Database, sessionId: string, id: string): OwnedRow[] {
  return db
    .prepare(
      `SELECT key, id, title, kind, current_version, status, expires_at,
              owner_kind, owner_agent, owner_pipeline, owner_stage, source_session_id
       FROM artifacts
       WHERE id = ? AND source_session_id = ? AND deleted_at IS NULL AND hidden = 0`,
    )
    .all(id, sessionId) as OwnedRow[];
}

/** An artifact created in this conversation that is still available. Project artifacts with no session id do not match. */
function findSessionArtifact(db: Database.Database, sessionId: string, ref: string, nowIso: string): OwnedRow | undefined {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > 300 || trimmed.includes("..") || trimmed.includes("\\") || trimmed.includes("\0")) return undefined;
  const parsed = parseArtifactShowKey(trimmed);
  const id = parsed?.id ?? trimmed;
  if (!ARTIFACT_ID_PATTERN.test(id)) return undefined;
  const rows = ownedRows(db, sessionId, id).filter((row) => row.status === "available" && !pastExpiry(row.expires_at, nowIso));
  if (parsed) return rows.find((row) => publicKeyOf(row) === `${parsed.ownerKey}/${parsed.id}`);
  return rows.length === 1 ? rows[0] : undefined;
}

export function sessionArtifactVisible(db: Database.Database, sessionId: string, part: UiPartArtifactRef, nowIso = new Date().toISOString()): boolean {
  const row = findSessionArtifact(db, sessionId, part.key, nowIso);
  if (!row) return false;
  if (part.version === undefined) return true;
  if (!Number.isInteger(part.version) || part.version < 1 || part.version > row.current_version) return false;
  return readArtifactVersionRow(db, row.key, part.version) !== undefined;
}

function safeContentType(value: string | null): string | undefined {
  if (!value) return undefined;
  if (value.length > 120 || /[\r\n\\]/.test(value) || value.includes("..")) return undefined;
  return value;
}

/**
 * Inline view of one artifact created in this session.
 * Live declarative data is the stored snapshot only: this does not run bindings.
 * Bytes come from the artifact store. A run-workspace file is not read.
 */
export async function readVisitorArtifact(
  db: Database.Database,
  sessionId: string,
  ref: string,
  version: number | undefined,
  nowIso = new Date().toISOString(),
): Promise<VisitorArtifactView | null> {
  const row = findSessionArtifact(db, sessionId, ref, nowIso);
  if (!row) return null;
  const wanted = version ?? row.current_version;
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > row.current_version) return null;
  const stored = readArtifactVersionRow(db, row.key, wanted);
  if (!stored || stored.storage !== "store" || !stored.relative_path) return null;
  const kind = artifactVersionKind(stored.manifest_json) ?? row.kind;
  let text: string | null = null;
  if (kind !== "static.image") {
    if (stored.size_bytes !== null && contentTooLarge(stored.size_bytes, false)) return null;
    let bytes: Buffer;
    try {
      bytes = await readStoredArtifactFile(row.key, stored.version, stored.relative_path);
    } catch {
      return null;
    }
    if (!isUtf8(bytes) || contentTooLarge(bytes.length, false)) return null;
    text = bytes.toString("utf8");
  }
  const view: VisitorArtifactView = {
    kind,
    title: row.title,
    version: stored.version,
    text,
  };
  const contentType = safeContentType(stored.content_type);
  if (contentType) view.contentType = contentType;
  if (kind === "live.html") {
    const manifest = parseStoredHtmlManifest(stored.manifest_json);
    const libraries = (manifest?.libraries ?? []).map((library) => ({ name: library.name, version: library.version }));
    if (libraries.length > 0) view.libraries = libraries;
  } else if (kind === "live.declarative") {
    const manifest = parseStoredLiveManifest(stored.manifest_json);
    if (manifest?.format) view.format = manifest.format;
    if (manifest?.library?.name && manifest.library.version) {
      view.library = { name: manifest.library.name, version: manifest.library.version };
    }
    const bindings = (manifest?.bindings ?? []).map((binding) => ({ id: binding.id, function: binding.function, args: binding.args }));
    if (bindings.length > 0) view.bindings = bindings;
    try {
      const snap = readArtifactSnapshots(db, row.key);
      const snapshots = snap.snapshots.map((item) => ({
        binding_id: item.binding_id,
        value: item.value,
        fetched_at: item.fetched_at,
        status: item.status,
      }));
      if (snapshots.length > 0) view.snapshots = snapshots;
    } catch {
      // A static read of a live row that cannot load snapshots still returns the program.
    }
  }
  return view;
}
