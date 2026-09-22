import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveStoreRoot } from "../runstore/paths.js";
import { MESSAGE_TOMBSTONE_RETENTION_MS, TERMINAL_RETENTION_MS } from "./limits.js";

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed";

export type A2aTaskRow = {
  task_id: string;
  context_id: string;
  caller_id: string;
  publication_id: string;
  publication_revision: string;
  submission_key: string;
  run_id: string | null;
  state: TaskState;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};

export type A2aArtifactRow = {
  artifact_id: string;
  task_id: string;
  name: string;
  media_type: string | null;
  size: number;
  content_path: string;
  hash: string;
  created_at: string;
};

export type FrozenResult = {
  summary: string;
  payload?: Record<string, unknown>;
  artifacts: Array<{ name: string; mediaType?: string; bytes: Buffer }>;
};

export type MessageRecord = {
  taskId: string;
  requestHash: string;
  outcome: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class A2aStore {
  private readonly db: Database.Database;
  private readonly artifactsRoot: string;
  private readonly ownsConnection: boolean;

  /**
   * Uses the SqliteRunStore connection to the same `state.db` file so the two stores share one
   * transaction domain. The Host must open the run store in migrate mode before constructing
   * A2aStore.
   */
  constructor(rootDir: string, connection: Database.Database) {
    this.db = connection;
    this.ownsConnection = false;
    this.artifactsRoot = path.join(resolveStoreRoot(rootDir), "a2a-artifacts");
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  ensureContext(callerId: string, contextId: string | undefined): string {
    if (contextId) {
      const row = this.db
        .prepare("SELECT caller_id FROM a2a_contexts WHERE context_id = ?")
        .get(contextId) as { caller_id: string } | undefined;
      if (row && row.caller_id !== callerId) {
        throw new Error("Context belongs to a different caller");
      }
      if (row) return contextId;
      this.db
        .prepare("INSERT INTO a2a_contexts (context_id, caller_id, created_at) VALUES (?, ?, ?)")
        .run(contextId, callerId, nowIso());
      return contextId;
    }
    const generated = randomUUID();
    this.db
      .prepare("INSERT INTO a2a_contexts (context_id, caller_id, created_at) VALUES (?, ?, ?)")
      .run(generated, callerId, nowIso());
    return generated;
  }

  getMessage(callerId: string, messageId: string): MessageRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT task_id AS taskId, request_hash AS requestHash, outcome_json AS outcomeJson FROM a2a_messages WHERE caller_id = ? AND message_id = ?",
      )
      .get(callerId, messageId) as { taskId: string; requestHash: string; outcomeJson: string | null } | undefined;
    if (!row) return undefined;
    return { taskId: row.taskId, requestHash: row.requestHash, outcome: row.outcomeJson ? JSON.parse(row.outcomeJson) : undefined };
  }

  recordMessage(params: {
    callerId: string;
    messageId: string;
    taskId: string;
    operation: string;
    requestHash: string;
    outcome: unknown;
  }): void {
    this.db
      .prepare(
        "INSERT INTO a2a_messages (caller_id, message_id, task_id, operation, request_hash, outcome_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        params.callerId,
        params.messageId,
        params.taskId,
        params.operation,
        params.requestHash,
        JSON.stringify(params.outcome),
        nowIso(),
      );
  }

  getTaskBySubmissionKey(key: string): A2aTaskRow | undefined {
    return this.db.prepare("SELECT * FROM a2a_tasks WHERE submission_key = ?").get(key) as A2aTaskRow | undefined;
  }

  createTask(params: {
    taskId: string;
    contextId: string;
    callerId: string;
    publicationId: string;
    publicationRevision: string;
    submissionKey: string;
    runId: string;
  }): A2aTaskRow {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO a2a_tasks
          (task_id, context_id, caller_id, publication_id, publication_revision, submission_key, run_id, state, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', NULL, ?, ?)`,
      )
      .run(
        params.taskId,
        params.contextId,
        params.callerId,
        params.publicationId,
        params.publicationRevision,
        params.submissionKey,
        params.runId,
        at,
        at,
      );
    return this.getTask(params.taskId)!;
  }

  getTask(taskId: string): A2aTaskRow | undefined {
    return this.db.prepare("SELECT * FROM a2a_tasks WHERE task_id = ?").get(taskId) as A2aTaskRow | undefined;
  }

  listTasksForCaller(callerId: string, contextId: string | undefined): A2aTaskRow[] {
    if (contextId) {
      return this.db
        .prepare("SELECT * FROM a2a_tasks WHERE caller_id = ? AND context_id = ? ORDER BY created_at ASC")
        .all(callerId, contextId) as A2aTaskRow[];
    }
    return this.db
      .prepare("SELECT * FROM a2a_tasks WHERE caller_id = ? ORDER BY created_at ASC")
      .all(callerId) as A2aTaskRow[];
  }

  getArtifact(taskId: string, artifactId: string): A2aArtifactRow | undefined {
    return this.db
      .prepare("SELECT * FROM a2a_artifacts WHERE task_id = ? AND artifact_id = ?")
      .get(taskId, artifactId) as A2aArtifactRow | undefined;
  }

  listArtifacts(taskId: string): A2aArtifactRow[] {
    return this.db.prepare("SELECT * FROM a2a_artifacts WHERE task_id = ?").all(taskId) as A2aArtifactRow[];
  }

  /** Freezes a successful outcome exactly once; a second call for an already-terminal task is a no-op. */
  async freezeCompleted(taskId: string, result: FrozenResult): Promise<void> {
    return this.freeze(taskId, "completed", result);
  }

  /** Freezes a failure exactly once; a second call for an already-terminal task is a no-op. */
  async freezeFailed(taskId: string): Promise<void> {
    return this.freeze(taskId, "failed", undefined);
  }

  private async freeze(taskId: string, state: "completed" | "failed", result: FrozenResult | undefined): Promise<void> {
    const current = this.getTask(taskId);
    if (!current || current.state === "completed" || current.state === "failed") return;
    const artifactRows: A2aArtifactRow[] = [];
    if (result) {
      for (const artifact of result.artifacts) {
        const artifactId = randomUUID();
        const hash = createHash("sha256").update(artifact.bytes).digest("hex");
        const dir = path.join(this.artifactsRoot, taskId);
        await mkdir(dir, { recursive: true });
        const contentPath = path.join(dir, artifactId);
        await writeFile(contentPath, artifact.bytes);
        artifactRows.push({
          artifact_id: artifactId,
          task_id: taskId,
          name: artifact.name,
          media_type: artifact.mediaType ?? null,
          size: artifact.bytes.length,
          content_path: contentPath,
          hash,
          created_at: nowIso(),
        });
      }
    }
    const resultJson = result ? JSON.stringify({ summary: result.summary, payload: result.payload }) : null;
    const transact = this.db.transaction(() => {
      const outcome = this.db
        .prepare("UPDATE a2a_tasks SET state = ?, result_json = ?, updated_at = ? WHERE task_id = ? AND state NOT IN ('completed', 'failed')")
        .run(state, resultJson, nowIso(), taskId);
      if (outcome.changes === 0) return;
      for (const row of artifactRows) {
        this.db
          .prepare(
            "INSERT INTO a2a_artifacts (artifact_id, task_id, name, media_type, size, content_path, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(row.artifact_id, row.task_id, row.name, row.media_type, row.size, row.content_path, row.hash, row.created_at);
      }
    });
    transact();
  }

  countNonterminal(callerId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM a2a_tasks WHERE caller_id = ? AND state NOT IN ('completed', 'failed')")
      .get(callerId) as { n: number };
    return row.n;
  }

  /** Deletes terminal tasks (and their frozen artifact files) and message tombstones older than the retention window. */
  async pruneExpired(
    now: Date,
    terminalRetentionMs: number = TERMINAL_RETENTION_MS,
    messageRetentionMs: number = MESSAGE_TOMBSTONE_RETENTION_MS,
  ): Promise<{ removedTasks: number; removedMessages: number }> {
    const terminalCutoff = new Date(now.getTime() - terminalRetentionMs).toISOString();
    const messageCutoff = new Date(now.getTime() - messageRetentionMs).toISOString();
    const expiredTasks = this.db
      .prepare("SELECT task_id FROM a2a_tasks WHERE state IN ('completed', 'failed') AND updated_at < ?")
      .all(terminalCutoff) as Array<{ task_id: string }>;
    for (const { task_id: taskId } of expiredTasks) {
      for (const artifact of this.listArtifacts(taskId)) {
        await unlink(artifact.content_path).catch(() => undefined);
      }
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM a2a_artifacts WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM a2a_messages WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM a2a_tasks WHERE task_id = ?").run(taskId);
      })();
    }
    const removedMessages = this.db.prepare("DELETE FROM a2a_messages WHERE created_at < ?").run(messageCutoff).changes;
    return { removedTasks: expiredTasks.length, removedMessages };
  }

  /** Deletes every A2A task (and frozen artifact files) bound to a Stageflow run. */
  async deleteByRunId(runId: string): Promise<{ removedTasks: number }> {
    const tasks = this.db
      .prepare("SELECT task_id FROM a2a_tasks WHERE run_id = ?")
      .all(runId) as Array<{ task_id: string }>;
    for (const { task_id: taskId } of tasks) {
      for (const artifact of this.listArtifacts(taskId)) {
        await unlink(artifact.content_path).catch(() => undefined);
      }
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM a2a_artifacts WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM a2a_messages WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM a2a_tasks WHERE task_id = ?").run(taskId);
      })();
    }
    return { removedTasks: tasks.length };
  }
}
