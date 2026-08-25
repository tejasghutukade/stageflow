import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { StageEnvelope } from "../../types/envelope.js";
import type { StageLogLine } from "../../agent/activity.js";
import { derivePendingPrompt } from "../../hitl/qaTrail.js";
import {
  stageStatusFromEvents,
  type CreateRunInput,
  type CreatedRun,
  type RunDetail,
  type RunMeta,
  type RunStatus,
  type RunStore,
  type RunSummary,
  type StageExecution,
  type StageExecutionPatch,
  type StageLogEvent,
  type StageSnapshot,
} from "../port.js";
import { projectRunDetail, projectRunSummary, orderStageSnapshots } from "../runProjection.js";
import { buildStageSnapshotFromStore } from "../stageSnapshot.js";
import { parsePipelineDagSnapshot } from "../pipelineDagSnapshot.js";
import { newRunId, runWorkspaceDir } from "../paths.js";
import {
  attemptAgentDir,
  attemptArtifactsDir,
  stageDir,
} from "../workspaceLayout.js";
import { importDiskRunsIfEmpty } from "./migrateFromDisk.js";
import { SCHEMA_SQL } from "./schema.js";

type RunRow = {
  run_id: string;
  pipeline_id: string;
  task_id: string | null;
  task_yaml: string;
  status: string;
  created_at: string;
  updated_at: string;
  checkout_root: string | null;
  pipeline_dag_json: string | null;
  git_sha: string | null;
  ci_pr_url: string | null;
  ci_job_url: string | null;
};

type StageRow = {
  run_id: string;
  stage_id: string;
  status: string | null;
  summary: string | null;
  envelope_json: string | null;
  started_at: string | null;
  finished_at: string | null;
};

type EventRow = {
  at: string;
  event: string;
  payload_json: string | null;
};

type ExecutionRow = {
  run_id: string;
  stage_id: string;
  attempt: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  envelope_json: string | null;
};

const ensuredStageDirs = new Set<string>();

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

function readSqliteBusyTimeoutMs(): number {
  const raw = process.env.STAGEFLOW_SQLITE_BUSY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  }
  return parsed;
}

function ensureCheckoutRootColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "checkout_root")) {
    db.exec(`ALTER TABLE runs ADD COLUMN checkout_root TEXT`);
  }
}

function ensureCiIdentityColumns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  for (const name of ["git_sha", "ci_pr_url", "ci_job_url"] as const) {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
    }
  }
}

function ensurePipelineDagColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "pipeline_dag_json")) {
    db.exec(`ALTER TABLE runs ADD COLUMN pipeline_dag_json TEXT`);
  }
}

function ensureStageExecutionsTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS stage_executions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  envelope_json TEXT,
  PRIMARY KEY (run_id, stage_id, attempt),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_stage_executions_run_stage
  ON stage_executions (run_id, stage_id, attempt);
`);
}

function ensureStageEventsAttemptColumn(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(stage_events)`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "attempt")) {
    db.exec(`ALTER TABLE stage_events ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`);
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_stage_events_run_stage_attempt_at
  ON stage_events (run_id, stage_id, attempt, at);
`);
  }
}

function executionFromRow(row: ExecutionRow): StageExecution {
  return {
    run_id: row.run_id,
    stage_id: row.stage_id,
    attempt: row.attempt,
    status: row.status as StageExecution["status"],
    ...(row.started_at != null ? { started_at: row.started_at } : {}),
    ...(row.finished_at != null ? { finished_at: row.finished_at } : {}),
    envelope: row.envelope_json
      ? (JSON.parse(row.envelope_json) as StageExecution["envelope"])
      : null,
  };
}

export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database;
  private migratePromise: Promise<void>;

  constructor(private readonly storeRoot: string) {
    const dbPath = path.join(storeRoot, "state.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${readSqliteBusyTimeoutMs()}`);
    this.db.exec(SCHEMA_SQL);
    ensureCheckoutRootColumn(this.db);
    ensureCiIdentityColumns(this.db);
    ensurePipelineDagColumn(this.db);
    ensureStageExecutionsTable(this.db);
    ensureStageEventsAttemptColumn(this.db);
    this.migratePromise = importDiskRunsIfEmpty(this.db, storeRoot).then(() => undefined);
  }

  /** Await one-shot disk import before catalog reads (create paths also wait). */
  async ready(): Promise<void> {
    await this.migratePromise;
  }

  getWorkspaceDir(runId: string): string {
    return runWorkspaceDir(this.storeRoot, runId);
  }

  async createRun(input: CreateRunInput): Promise<CreatedRun> {
    await this.ready();
    const runId = newRunId();
    const workspaceDir = this.getWorkspaceDir(runId);
    await mkdir(path.join(workspaceDir, "stages"), { recursive: true });

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs
          (run_id, pipeline_id, task_id, task_yaml, status, created_at, updated_at, checkout_root, pipeline_dag_json, git_sha, ci_pr_url, ci_job_url)
         VALUES
          (@run_id, @pipeline_id, @task_id, @task_yaml, @status, @created_at, @updated_at, @checkout_root, @pipeline_dag_json, @git_sha, @ci_pr_url, @ci_job_url)`,
      )
      .run({
        run_id: runId,
        pipeline_id: input.pipelineId,
        task_id: input.taskId ?? null,
        task_yaml: input.taskYaml,
        status: "running",
        created_at: now,
        updated_at: now,
        checkout_root: input.checkoutRoot ?? null,
        pipeline_dag_json: input.pipelineDag
          ? JSON.stringify(input.pipelineDag)
          : null,
        git_sha: input.gitSha ?? null,
        ci_pr_url: input.ciPrUrl ?? null,
        ci_job_url: input.ciJobUrl ?? null,
      });

    return { runId, workspaceDir };
  }

  async updateRunStatus(runId: string, status: RunStatus): Promise<void> {
    await this.ready();
    const result = this.db
      .prepare(
        `UPDATE runs SET status = @status, updated_at = @updated_at WHERE run_id = @run_id`,
      )
      .run({
        run_id: runId,
        status,
        updated_at: new Date().toISOString(),
      });
    if (result.changes === 0) {
      throw new Error(`Run not found: ${runId}`);
    }
  }

  async readRunMeta(runId: string): Promise<RunMeta> {
    await this.ready();
    return this.runMetaFromRow(this.getRunRow(runId));
  }

  async readTaskYaml(runId: string): Promise<string> {
    await this.ready();
    return this.getRunRow(runId).task_yaml;
  }

  async ensureStageWorkspace(runId: string, stageId: string): Promise<void> {
    await this.ready();
    this.getRunRow(runId);
    const workspaceDir = this.getWorkspaceDir(runId);
    const dir = stageDir(workspaceDir, stageId);
    if (!ensuredStageDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      ensuredStageDirs.add(dir);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stages (run_id, stage_id, status)
         VALUES (@run_id, @stage_id, @status)`,
      )
      .run({ run_id: runId, stage_id: stageId, status: "pending" });
  }

  async ensureAttemptWorkspace(
    runId: string,
    stageId: string,
    attempt: number,
  ): Promise<void> {
    await this.ready();
    await this.ensureStageWorkspace(runId, stageId);
    this.getRunRow(runId);
    const workspaceDir = this.getWorkspaceDir(runId);
    const key = `${runId}:${stageId}:${attempt}`;
    if (!ensuredStageDirs.has(key)) {
      await mkdir(attemptArtifactsDir(workspaceDir, stageId, attempt), {
        recursive: true,
      });
      await mkdir(attemptAgentDir(workspaceDir, stageId, attempt), {
        recursive: true,
      });
      ensuredStageDirs.add(key);
    }
  }

  async createStageExecution(
    runId: string,
    stageId: string,
  ): Promise<StageExecution> {
    await this.ready();
    this.getRunRow(runId);
    return this.db.transaction(() => {
      const maxRow = this.db
        .prepare(
          `SELECT MAX(attempt) AS max_attempt FROM stage_executions
           WHERE run_id = ? AND stage_id = ?`,
        )
        .get(runId, stageId) as { max_attempt: number | null } | undefined;
      const attempt = (maxRow?.max_attempt ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO stage_executions (run_id, stage_id, attempt, status)
           VALUES (@run_id, @stage_id, @attempt, @status)`,
        )
        .run({
          run_id: runId,
          stage_id: stageId,
          attempt,
          status: "pending",
        });
      const row = this.db
        .prepare(
          `SELECT run_id, stage_id, attempt, status, started_at, finished_at, envelope_json
           FROM stage_executions
           WHERE run_id = ? AND stage_id = ? AND attempt = ?`,
        )
        .get(runId, stageId, attempt) as ExecutionRow;
      return executionFromRow(row);
    })();
  }

  async listStageExecutions(
    runId: string,
    stageId: string,
  ): Promise<StageExecution[]> {
    await this.ready();
    const rows = this.db
      .prepare(
        `SELECT run_id, stage_id, attempt, status, started_at, finished_at, envelope_json
         FROM stage_executions
         WHERE run_id = ? AND stage_id = ?
         ORDER BY attempt ASC`,
      )
      .all(runId, stageId) as ExecutionRow[];
    return rows.map(executionFromRow);
  }

  async getLatestStageExecution(
    runId: string,
    stageId: string,
  ): Promise<StageExecution | null> {
    await this.ready();
    const row = this.db
      .prepare(
        `SELECT run_id, stage_id, attempt, status, started_at, finished_at, envelope_json
         FROM stage_executions
         WHERE run_id = ? AND stage_id = ?
         ORDER BY attempt DESC
         LIMIT 1`,
      )
      .get(runId, stageId) as ExecutionRow | undefined;
    return row ? executionFromRow(row) : null;
  }

  async countStageAttempts(runId: string, stageId: string): Promise<number> {
    await this.ready();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM stage_executions
         WHERE run_id = ? AND stage_id = ?`,
      )
      .get(runId, stageId) as { n: number };
    return row.n;
  }

  async getStageExecution(
    runId: string,
    stageId: string,
    attempt: number,
  ): Promise<StageExecution> {
    await this.ready();
    const row = this.db
      .prepare(
        `SELECT run_id, stage_id, attempt, status, started_at, finished_at, envelope_json
         FROM stage_executions
         WHERE run_id = ? AND stage_id = ? AND attempt = ?`,
      )
      .get(runId, stageId, attempt) as ExecutionRow | undefined;
    if (!row) {
      throw new Error(
        `Stage execution not found: ${runId}/${stageId} attempt ${attempt}`,
      );
    }
    return executionFromRow(row);
  }

  async updateStageExecution(
    runId: string,
    stageId: string,
    attempt: number,
    patch: StageExecutionPatch,
  ): Promise<void> {
    await this.ready();
    const sets: string[] = [];
    const params: Record<string, unknown> = {
      run_id: runId,
      stage_id: stageId,
      attempt,
    };
    if (patch.status !== undefined) {
      sets.push("status = @status");
      params.status = patch.status;
    }
    if (patch.started_at !== undefined) {
      sets.push("started_at = @started_at");
      params.started_at = patch.started_at;
    }
    if (patch.finished_at !== undefined) {
      sets.push("finished_at = @finished_at");
      params.finished_at = patch.finished_at;
    }
    if (patch.envelope !== undefined) {
      sets.push("envelope_json = @envelope_json");
      params.envelope_json =
        patch.envelope != null ? JSON.stringify(patch.envelope) : null;
    }
    if (sets.length === 0) return;
    const result = this.db
      .prepare(
        `UPDATE stage_executions SET ${sets.join(", ")}
         WHERE run_id = @run_id AND stage_id = @stage_id AND attempt = @attempt`,
      )
      .run(params);
    if (result.changes === 0) {
      throw new Error(
        `Stage execution not found: ${runId}/${stageId} attempt ${attempt}`,
      );
    }
  }

  async writeEnvelope(
    runId: string,
    stageId: string,
    envelope: StageEnvelope,
    options?: { attempt?: number },
  ): Promise<void> {
    const attempt = options?.attempt ?? 1;
    await this.ensureAttemptWorkspace(runId, stageId, attempt);
    this.db
      .prepare(
        `INSERT INTO stages
           (run_id, stage_id, status, summary, envelope_json)
         VALUES
           (@run_id, @stage_id, @status, @summary, @envelope_json)
         ON CONFLICT(run_id, stage_id) DO UPDATE SET
           summary = excluded.summary,
           envelope_json = excluded.envelope_json`,
      )
      .run({
        run_id: runId,
        stage_id: stageId,
        status: envelope.status === "success" ? "succeeded" : "failed",
        summary: envelope.summary,
        envelope_json: JSON.stringify(envelope),
      });

    await this.updateStageExecution(runId, stageId, attempt, { envelope });
  }

  async readEnvelope(runId: string, stageId: string): Promise<StageEnvelope> {
    await this.ready();
    const execution = await this.getLatestStageExecution(runId, stageId);
    if (execution?.envelope != null) {
      return execution.envelope;
    }
    const fromStages = this.readEnvelopeFromDb(runId, stageId);
    if (fromStages != null) {
      return fromStages;
    }
    throw new Error(`Envelope not found: ${runId}/${stageId}`);
  }

  private readEnvelopeFromDb(
    runId: string,
    stageId: string,
  ): StageEnvelope | null {
    const row = this.db
      .prepare(
        `SELECT envelope_json FROM stages WHERE run_id = ? AND stage_id = ?`,
      )
      .get(runId, stageId) as { envelope_json: string | null } | undefined;
    if (row?.envelope_json == null) {
      return null;
    }
    return JSON.parse(row.envelope_json) as StageEnvelope;
  }

  async appendStageEvent(
    runId: string,
    stageId: string,
    event: StageLogLine,
    options?: { attempt?: number },
  ): Promise<void> {
    const attempt = options?.attempt ?? 1;
    await this.ensureAttemptWorkspace(runId, stageId, attempt);
    const at = new Date().toISOString();
    const eventName = event.event;
    const rest: Record<string, unknown> = { ...event };
    delete rest.event;
    delete rest.at;
    this.db
      .prepare(
        `INSERT INTO stage_events (run_id, stage_id, attempt, at, event, payload_json)
         VALUES (@run_id, @stage_id, @attempt, @at, @event, @payload_json)`,
      )
      .run({
        run_id: runId,
        stage_id: stageId,
        attempt,
        at,
        event: eventName,
        payload_json: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
      });

    this.updateStageStatusDenorm(runId, stageId, eventName, at);
  }

  /**
   * @remarks Intentional denormalization: mirrors lifecycle events into
   * `stages.status` for legacy compatibility. This column is not the
   * authoritative source for snapshot projection; status is event-derived
   * in `buildStageSnapshotFromStore`.
   */
  private updateStageStatusDenorm(
    runId: string,
    stageId: string,
    eventName: string,
    at: string,
  ): void {
    if (eventName === "started" || eventName === "resumed") {
      this.db
        .prepare(
          `UPDATE stages SET status = 'running', started_at = COALESCE(started_at, @at)
           WHERE run_id = @run_id AND stage_id = @stage_id`,
        )
        .run({ run_id: runId, stage_id: stageId, at });
    } else if (eventName === "waiting_for_input") {
      this.db
        .prepare(
          `UPDATE stages SET status = 'waiting_for_input'
           WHERE run_id = @run_id AND stage_id = @stage_id`,
        )
        .run({ run_id: runId, stage_id: stageId });
    } else if (eventName === "succeeded" || eventName === "failed") {
      this.db
        .prepare(
          `UPDATE stages SET status = @status, finished_at = @at
           WHERE run_id = @run_id AND stage_id = @stage_id`,
        )
        .run({
          run_id: runId,
          stage_id: stageId,
          status: eventName,
          at,
        });
    }
  }

  async listStageEvents(
    runId: string,
    stageId: string,
    attempt?: number,
  ): Promise<StageLogEvent[]> {
    await this.ready();
    return this.loadEvents(runId, stageId, attempt);
  }

  async listRuns(): Promise<RunSummary[]> {
    await this.ready();
    const rows = this.db
      .prepare(
        `SELECT run_id, pipeline_id, task_id, task_yaml, status, created_at, updated_at, checkout_root, pipeline_dag_json, git_sha, ci_pr_url, ci_job_url
         FROM runs ORDER BY created_at DESC`,
      )
      .all() as RunRow[];

    const summaries: RunSummary[] = [];
    for (const row of rows) {
      const dagSnapshot = this.readPipelineDagSnapshotFromRow(row);
      const stages = await this.loadStageSnapshots(row.run_id, dagSnapshot?.stage_ids);
      summaries.push(projectRunSummary(this.runMetaFromRow(row), stages));
    }
    return summaries;
  }

  async readRun(runId: string): Promise<RunDetail> {
    await this.ready();
    const row = this.getRunRow(runId);
    const dagSnapshot = this.readPipelineDagSnapshotFromRow(row);
    const stages = await this.loadStageSnapshots(runId, dagSnapshot?.stage_ids);
    return projectRunDetail(
      this.runMetaFromRow(row),
      stages,
      row.task_yaml,
      dagSnapshot,
    );
  }

  private readPipelineDagSnapshotFromRow(row: RunRow) {
    if (!row.pipeline_dag_json) return null;
    return parsePipelineDagSnapshot(JSON.parse(row.pipeline_dag_json));
  }

  private runMetaFromRow(row: RunRow): RunMeta {
    return {
      run_id: row.run_id,
      pipeline_id: row.pipeline_id,
      created_at: row.created_at,
      status: row.status as RunStatus,
      task_id: row.task_id ?? undefined,
      updated_at: row.updated_at,
      ...(row.checkout_root != null ? { checkout_root: row.checkout_root } : {}),
      ...(row.git_sha != null ? { git_sha: row.git_sha } : {}),
      ...(row.ci_pr_url != null ? { ci_pr_url: row.ci_pr_url } : {}),
      ...(row.ci_job_url != null ? { ci_job_url: row.ci_job_url } : {}),
    };
  }

  private getRunRow(runId: string): RunRow {
    const row = this.db
      .prepare(
        `SELECT run_id, pipeline_id, task_id, task_yaml, status, created_at, updated_at, checkout_root, pipeline_dag_json, git_sha, ci_pr_url, ci_job_url
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as RunRow | undefined;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return row;
  }

  private loadEvents(
    runId: string,
    stageId: string,
    attempt?: number,
  ): StageLogEvent[] {
    const rows = attempt
      ? (this.db
          .prepare(
            `SELECT at, event, payload_json FROM stage_events
             WHERE run_id = ? AND stage_id = ? AND attempt = ?
             ORDER BY id ASC`,
          )
          .all(runId, stageId, attempt) as EventRow[])
      : (this.db
          .prepare(
            `SELECT at, event, payload_json FROM stage_events
             WHERE run_id = ? AND stage_id = ?
             ORDER BY id ASC`,
          )
          .all(runId, stageId) as EventRow[]);

    return rows.map((row) => {
      const payload = row.payload_json
        ? (JSON.parse(row.payload_json) as Record<string, unknown>)
        : {};
      return { event: row.event, at: row.at, ...payload } as StageLogEvent;
    });
  }

  private async loadStageSnapshots(
    runId: string,
    stageIds?: string[],
  ): Promise<StageSnapshot[]> {
    const workspaceDir = this.getWorkspaceDir(runId);
    const rows = this.db
      .prepare(
        `SELECT stage_id FROM stages WHERE run_id = ? ORDER BY stage_id ASC`,
      )
      .all(runId) as { stage_id: string }[];

    const ids =
      stageIds?.length
        ? stageIds
        : rows.map((row) => row.stage_id);

    const snapshots = await Promise.all(
      ids.map((stageId) =>
        buildStageSnapshotFromStore(this, runId, stageId, workspaceDir),
      ),
    );

    if (stageIds?.length) {
      return orderStageSnapshots(stageIds, snapshots);
    }
    return snapshots;
  }
}

export function openSqliteRunStore(storeRoot: string): SqliteRunStore {
  return new SqliteRunStore(storeRoot);
}
