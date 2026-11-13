import type Database from "better-sqlite3";
import { agentProjectKey } from "../agents/store.js";
import type { FunctionDefinition, FunctionIssue } from "../config/loadFunction.js";

export { agentProjectKey };

export type FunctionRevisionSource = "console" | "file" | "api";

export type FunctionDefinitionRow = {
  functionId: string;
  currentRevision: number;
  deleted: boolean;
  fileHash: string | null;
  issues: FunctionIssue[];
  createdAt: string;
  updatedAt: string;
};

export type FunctionRevision = {
  functionId: string;
  revision: number;
  definition: FunctionDefinition;
  yaml: string;
  sourceHash: string;
  contractVersion: number;
  source: FunctionRevisionSource;
  author: string | null;
  summary: string | null;
  createdAt: string;
};

export type FunctionRevisionMeta = {
  functionId: string;
  revision: number;
  source: FunctionRevisionSource;
  author: string | null;
  summary: string | null;
  sourceHash: string;
  contractVersion: number;
  createdAt: string;
};

export type FunctionPin = {
  scope: "run" | "session";
  scopeId: string;
  functionId: string;
  revision: number;
  sourceHash: string;
  contractVersion: number;
  pinnedAt: string;
};

type Row = Record<string, unknown>;

const str = (value: unknown): string => value as string;
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function toDefinitionRow(row: Row): FunctionDefinitionRow {
  return {
    functionId: str(row.function_id),
    currentRevision: Number(row.current_revision),
    deleted: row.deleted === 1,
    fileHash: strOrNull(row.file_hash),
    issues: row.issues_json ? (JSON.parse(str(row.issues_json)) as FunctionIssue[]) : [],
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function toRevision(row: Row): FunctionRevision {
  return {
    functionId: str(row.function_id),
    revision: Number(row.revision),
    definition: JSON.parse(str(row.definition_json)) as FunctionDefinition,
    yaml: str(row.yaml_text),
    sourceHash: str(row.source_hash),
    contractVersion: Number(row.contract_version),
    source: str(row.source) as FunctionRevisionSource,
    author: strOrNull(row.author),
    summary: strOrNull(row.summary),
    createdAt: str(row.created_at),
  };
}

export class FunctionStore {
  constructor(private readonly db: Database.Database) {}

  listDefinitions(projectKey: string): FunctionDefinitionRow[] {
    return (
      this.db.prepare(`SELECT * FROM function_definitions WHERE project_key = ? ORDER BY function_id`).all(projectKey) as Row[]
    ).map(toDefinitionRow);
  }

  getDefinition(projectKey: string, functionId: string): FunctionDefinitionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM function_definitions WHERE project_key = ? AND function_id = ?`)
      .get(projectKey, functionId) as Row | undefined;
    return row ? toDefinitionRow(row) : undefined;
  }

  updateDefinitionState(
    projectKey: string,
    functionId: string,
    patch: { deleted?: boolean; fileHash?: string | null; issues?: FunctionIssue[] },
    now: string,
  ): void {
    const current = this.getDefinition(projectKey, functionId);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE function_definitions
           SET deleted = ?, file_hash = ?, issues_json = ?, updated_at = ?
         WHERE project_key = ? AND function_id = ?`,
      )
      .run(
        (patch.deleted ?? current.deleted) ? 1 : 0,
        patch.fileHash === undefined ? current.fileHash : patch.fileHash,
        JSON.stringify(patch.issues ?? current.issues),
        now,
        projectKey,
        functionId,
      );
  }

  appendRevision(
    projectKey: string,
    input: {
      definition: FunctionDefinition;
      yaml: string;
      sourceHash: string;
      contractVersion: number;
      source: FunctionRevisionSource;
      author?: string | null;
      summary?: string | null;
      fileHash: string;
      now: string;
    },
  ): number {
    const functionId = input.definition.id;
    const existing = this.getDefinition(projectKey, functionId);
    const revision = (existing?.currentRevision ?? 0) + 1;
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO function_revisions
             (project_key, function_id, revision, definition_json, yaml_text, source_hash, contract_version, source, author, summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectKey,
          functionId,
          revision,
          JSON.stringify(input.definition),
          input.yaml,
          input.sourceHash,
          input.contractVersion,
          input.source,
          input.author ?? null,
          input.summary ?? null,
          input.now,
        );
      if (existing) {
        this.db
          .prepare(
            `UPDATE function_definitions
               SET current_revision = ?, deleted = 0, file_hash = ?, issues_json = '[]', updated_at = ?
             WHERE project_key = ? AND function_id = ?`,
          )
          .run(revision, input.fileHash, input.now, projectKey, functionId);
      } else {
        this.db
          .prepare(
            `INSERT INTO function_definitions
               (project_key, function_id, current_revision, deleted, file_hash, issues_json, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, '[]', ?, ?)`,
          )
          .run(projectKey, functionId, revision, input.fileHash, input.now, input.now);
      }
    });
    write();
    return revision;
  }

  recordInvalid(projectKey: string, functionId: string, fileHash: string, issues: FunctionIssue[], now: string): void {
    this.db
      .prepare(
        `INSERT INTO function_definitions
           (project_key, function_id, current_revision, deleted, file_hash, issues_json, created_at, updated_at)
         VALUES (?, ?, 0, 0, ?, ?, ?, ?)
         ON CONFLICT (project_key, function_id) DO UPDATE
           SET file_hash = excluded.file_hash, issues_json = excluded.issues_json, deleted = 0, updated_at = excluded.updated_at`,
      )
      .run(projectKey, functionId, fileHash, JSON.stringify(issues), now, now);
  }

  getRevision(projectKey: string, functionId: string, revision: number): FunctionRevision | undefined {
    const row = this.db
      .prepare(`SELECT * FROM function_revisions WHERE project_key = ? AND function_id = ? AND revision = ?`)
      .get(projectKey, functionId, revision) as Row | undefined;
    return row ? toRevision(row) : undefined;
  }

  listRevisions(projectKey: string, functionId: string): FunctionRevisionMeta[] {
    return (
      this.db
        .prepare(
          `SELECT function_id, revision, source, author, summary, source_hash, contract_version, created_at
             FROM function_revisions WHERE project_key = ? AND function_id = ? ORDER BY revision`,
        )
        .all(projectKey, functionId) as Row[]
    ).map((row) => ({
      functionId: str(row.function_id),
      revision: Number(row.revision),
      source: str(row.source) as FunctionRevisionSource,
      author: strOrNull(row.author),
      summary: strOrNull(row.summary),
      sourceHash: str(row.source_hash),
      contractVersion: Number(row.contract_version),
      createdAt: str(row.created_at),
    }));
  }

  upsertPin(
    projectKey: string,
    pin: { scope: "run" | "session"; scopeId: string; functionId: string; revision: number; sourceHash: string; contractVersion: number },
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO function_pins
           (project_key, scope, scope_id, function_id, revision, source_hash, contract_version, pinned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_key, scope, scope_id, function_id) DO UPDATE
           SET revision = excluded.revision, source_hash = excluded.source_hash,
               contract_version = excluded.contract_version, pinned_at = excluded.pinned_at`,
      )
      .run(projectKey, pin.scope, pin.scopeId, pin.functionId, pin.revision, pin.sourceHash, pin.contractVersion, now);
  }

  getPin(projectKey: string, scope: "run" | "session", scopeId: string, functionId: string): FunctionPin | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM function_pins WHERE project_key = ? AND scope = ? AND scope_id = ? AND function_id = ?`,
      )
      .get(projectKey, scope, scopeId, functionId) as Row | undefined;
    if (!row) return undefined;
    return {
      scope,
      scopeId: str(row.scope_id),
      functionId: str(row.function_id),
      revision: Number(row.revision),
      sourceHash: str(row.source_hash),
      contractVersion: Number(row.contract_version),
      pinnedAt: str(row.pinned_at),
    };
  }
}
