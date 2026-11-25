import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "../evals/canonical.js";
import { normalizeCspOrigin, parseStoredHtmlManifest, type HtmlCsp } from "./htmlManifest.js";
import { isLiveHtmlKind } from "./kinds.js";
import { ArtifactPublishError } from "./limits.js";

export const ORIGIN_APPROVAL_CAP = 8;

export const ORIGIN_APPROVAL_WARNING = "origins need approval in the console before they take effect";

export const ORIGIN_APPROVERS = ["console", "cli", "api"] as const;
export type OriginApprover = (typeof ORIGIN_APPROVERS)[number];

export type NormalizedOrigins = {
  connect: string[];
  resource: string[];
  base: string[];
};

export type ArtifactOriginView = NormalizedOrigins & {
  hash: string;
  approved: boolean;
  approved_at: string | null;
};

export type OriginApprovalRecord = {
  artifact_key: string;
  origins_hash: string;
  origins_json: string;
  approved_at: string;
  approved_by: OriginApprover;
};

type ArtifactHead = {
  hidden: number;
  deleted_at: string | null;
  kind: string;
  current_version: number;
};

function normalizeList(values: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const parsed = normalizeCspOrigin(trimmed);
    out.add("origin" in parsed ? parsed.origin : trimmed.toLowerCase());
  }
  return [...out].sort();
}

export function normalizeOrigins(csp: HtmlCsp | null | undefined): NormalizedOrigins {
  return {
    connect: normalizeList(csp?.connectDomains),
    resource: normalizeList(csp?.resourceDomains),
    base: normalizeList(csp?.baseUriDomains),
  };
}

export function originsHash(csp: HtmlCsp | null | undefined): string {
  return createHash("sha256").update(canonicalJson(normalizeOrigins(csp))).digest("hex");
}

export function declaredOriginCount(csp: HtmlCsp | null | undefined): number {
  const lists = normalizeOrigins(csp);
  return lists.connect.length + lists.resource.length + lists.base.length;
}

export function originApprovalView(
  db: Database.Database,
  storageKey: string,
  csp: HtmlCsp | null | undefined,
): ArtifactOriginView {
  const lists = normalizeOrigins(csp);
  const hash = originsHash(csp);
  if (declaredOriginCount(csp) === 0) {
    return { ...lists, hash, approved: true, approved_at: null };
  }
  const row = db
    .prepare(
      `SELECT approved_at FROM artifact_origin_approvals WHERE artifact_key = ? AND origins_hash = ?`,
    )
    .get(storageKey, hash) as { approved_at: string } | undefined;
  return {
    ...lists,
    hash,
    approved: row !== undefined,
    approved_at: row?.approved_at ?? null,
  };
}

export function listOriginApprovals(db: Database.Database, storageKey: string): OriginApprovalRecord[] {
  return db
    .prepare(
      `SELECT artifact_key, origins_hash, origins_json, approved_at, approved_by
       FROM artifact_origin_approvals
       WHERE artifact_key = ?
       ORDER BY approved_at DESC, origins_hash DESC`,
    )
    .all(storageKey) as OriginApprovalRecord[];
}

export function isApproved(db: Database.Database, storageKey: string, hash: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM artifact_origin_approvals WHERE artifact_key = ? AND origins_hash = ?`)
    .get(storageKey, hash) as { ok: number } | undefined;
  return row !== undefined;
}

function notFound(message = "Artifact not found"): never {
  throw new ArtifactPublishError(404, "artifact.not_found", message);
}

function invalidShape(message: string): never {
  throw new ArtifactPublishError(400, "artifact.invalid_shape", message, [{ path: "origins", message }]);
}

function mismatch(hash: string): never {
  throw new ArtifactPublishError(
    409,
    "artifact.origins_mismatch",
    "origins hash does not match the current manifest",
    [{ path: "origins_hash", message: "origins hash does not match the current manifest" }],
    undefined,
    { current_hash: hash },
  );
}

function loadHead(db: Database.Database, storageKey: string): ArtifactHead {
  const row = db
    .prepare(`SELECT hidden, deleted_at, kind, current_version FROM artifacts WHERE key = ?`)
    .get(storageKey) as ArtifactHead | undefined;
  if (row === undefined || row.hidden !== 0 || row.deleted_at !== null || storageKey.includes("::eval:")) {
    notFound();
  }
  return row!;
}

function readVersionCsp(db: Database.Database, storageKey: string, version: number): HtmlCsp | undefined {
  const row = db
    .prepare(`SELECT manifest_json FROM artifact_versions WHERE key = ? AND version = ?`)
    .get(storageKey, version) as { manifest_json: string | null } | undefined;
  if (row === undefined) return undefined;
  return parseStoredHtmlManifest(row.manifest_json)?.csp ?? {};
}

function evictOldest(db: Database.Database, storageKey: string): void {
  db.prepare(
    `DELETE FROM artifact_origin_approvals
     WHERE artifact_key = @key
       AND origins_hash IN (
         SELECT origins_hash FROM artifact_origin_approvals
         WHERE artifact_key = @key
         ORDER BY approved_at DESC, origins_hash DESC
         LIMIT -1 OFFSET ${ORIGIN_APPROVAL_CAP}
       )`,
  ).run({ key: storageKey });
}

export function approveOrigins(
  db: Database.Database,
  storageKey: string,
  input: { originsHash: string; version?: number; by: OriginApprover },
): { origins: ArtifactOriginView; approved: true; approved_at: string } {
  if (!ORIGIN_APPROVERS.includes(input.by)) invalidShape("approved_by is not valid");
  if (!/^[a-f0-9]{64}$/.test(input.originsHash)) invalidShape("origins_hash is not valid");
  const head = loadHead(db, storageKey);
  if (!isLiveHtmlKind(head.kind)) invalidShape("no origins to approve");
  const version = input.version ?? head.current_version;
  const csp = readVersionCsp(db, storageKey, version);
  if (csp === undefined) notFound("Artifact version not found");
  if (declaredOriginCount(csp) === 0) invalidShape("no origins to approve");
  const hash = originsHash(csp);
  if (hash !== input.originsHash) mismatch(hash);
  const approvedAt = new Date().toISOString();
  const originsJson = canonicalJson(normalizeOrigins(csp));
  db.transaction(() => {
    db.prepare(
      `INSERT INTO artifact_origin_approvals (artifact_key, origins_hash, origins_json, approved_at, approved_by)
       VALUES (@key, @hash, @json, @at, @by)
       ON CONFLICT (artifact_key, origins_hash) DO UPDATE SET
         origins_json = excluded.origins_json,
         approved_at = excluded.approved_at,
         approved_by = excluded.approved_by`,
    ).run({
      key: storageKey,
      hash,
      json: originsJson,
      at: approvedAt,
      by: input.by,
    });
    evictOldest(db, storageKey);
  }).immediate();
  return {
    origins: originApprovalView(db, storageKey, csp),
    approved: true,
    approved_at: approvedAt,
  };
}

export function revokeOrigins(
  db: Database.Database,
  storageKey: string,
  hash?: string,
): { revoked: number; origins: ArtifactOriginView | null } {
  const head = loadHead(db, storageKey);
  const result = db.transaction(() => {
    if (hash !== undefined) {
      return db
        .prepare(`DELETE FROM artifact_origin_approvals WHERE artifact_key = ? AND origins_hash = ?`)
        .run(storageKey, hash);
    }
    return db.prepare(`DELETE FROM artifact_origin_approvals WHERE artifact_key = ?`).run(storageKey);
  }).immediate();
  const current = isLiveHtmlKind(head.kind) ? readVersionCsp(db, storageKey, head.current_version) : undefined;
  const origins = current === undefined ? null : originApprovalView(db, storageKey, current);
  return { revoked: result.changes, origins };
}

export function deleteOriginApprovals(db: Database.Database, keys: readonly string[]): void {
  const chunkSize = 80;
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const slice = keys.slice(offset, offset + chunkSize);
    if (slice.length === 0) continue;
    const params: Record<string, string> = {};
    slice.forEach((key, index) => {
      params[`k${index}`] = key;
    });
    const names = slice.map((_, index) => `@k${index}`).join(", ");
    db.prepare(`DELETE FROM artifact_origin_approvals WHERE artifact_key IN (${names})`).run(params);
  }
}
