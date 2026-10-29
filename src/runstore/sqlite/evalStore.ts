import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { EVAL_LIMITS, EVAL_RUN_ID_PREFIX, type EvalBudgetWarning, type EvalTargetKind } from "../../evals/constants.js";
import { EvalStoreError } from "../../evals/storeError.js";
import type {
  CreateEvalRunInput,
  EvalCaseInput,
  EvalCaseRow,
  EvalGradeInput,
  EvalGradeRow,
  EvalGraderVersionInput,
  EvalResultInput,
  EvalResultRow,
  EvalResultWithGrades,
  EvalReviewPatch,
  EvalReviewRow,
  EvalRunPage,
  EvalRunProgress,
  EvalRunRow,
  FinishEvalRunInput,
  ListEvalRunsQuery,
} from "../../evals/storeTypes.js";

type EvalRunDbRow = {
  eval_run_id: string;
  project_root: string;
  eval_id: string;
  run_number: number;
  eval_path: string;
  eval_hash: string;
  target_kind: EvalRunRow["targetKind"];
  target_ref_json: string;
  target_version_hash: string;
  dataset_path: string;
  dataset_hash: string;
  config_json: string;
  config_fingerprint: string;
  config_components_json: string;
  status: EvalRunRow["status"];
  status_reason: string | null;
  passed: number | null;
  repeats: number;
  pass_threshold: number;
  max_cost_usd: number;
  cases_total: number;
  results_total: number;
  results_done: number;
  cost_usd: number;
  engine_name: string;
  engine_version: string;
  stageflow_version: string;
  label: string | null;
  started_via: EvalRunRow["startedVia"];
  caller_id: string | null;
  summary_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type EvalResultDbRow = {
  eval_run_id: string;
  case_id: string;
  repeat_index: number;
  status: EvalResultRow["status"];
  error_code: string | null;
  error_message: string | null;
  stage_run_id: string | null;
  subject_ref: string | null;
  turns: number | null;
  tool_call_count: number | null;
  output_json: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  score: number | null;
  passed: number;
  has_grader_errors: number;
  budget_warnings_json: string | null;
  started_at: string | null;
  finished_at: string | null;
};

type EvalGradeDbRow = {
  eval_run_id: string;
  case_id: string;
  repeat_index: number;
  grader_id: string;
  grader_type: string;
  status: EvalGradeRow["status"];
  passed: number | null;
  score: number | null;
  raw_value: number | null;
  reason: string | null;
  details_json: string | null;
  error_code: string | null;
  judge_model: string | null;
  judge_cost_usd: number | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
};

const now = (): string => new Date().toISOString();
const bool = (value: number | null): boolean | null => (value === null ? null : value !== 0);
const json = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));
const parse = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T));

function runFromDb(row: EvalRunDbRow): EvalRunRow {
  return {
    evalRunId: row.eval_run_id,
    projectRoot: row.project_root,
    evalId: row.eval_id,
    runNumber: row.run_number,
    evalPath: row.eval_path,
    evalHash: row.eval_hash,
    targetKind: row.target_kind,
    targetRef: JSON.parse(row.target_ref_json) as EvalRunRow["targetRef"],
    targetVersionHash: row.target_version_hash,
    datasetPath: row.dataset_path,
    datasetHash: row.dataset_hash,
    config: JSON.parse(row.config_json) as EvalRunRow["config"],
    configFingerprint: row.config_fingerprint,
    configComponents: JSON.parse(row.config_components_json) as EvalRunRow["configComponents"],
    status: row.status,
    statusReason: row.status_reason,
    passed: bool(row.passed),
    repeats: row.repeats,
    passThreshold: row.pass_threshold,
    maxCostUsd: row.max_cost_usd,
    casesTotal: row.cases_total,
    resultsTotal: row.results_total,
    resultsDone: row.results_done,
    costUsd: row.cost_usd,
    engineName: row.engine_name,
    engineVersion: row.engine_version,
    stageflowVersion: row.stageflow_version,
    label: row.label,
    startedVia: row.started_via,
    callerId: row.caller_id,
    summary: parse<EvalRunRow["summary"]>(row.summary_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function resultFromDb(row: EvalResultDbRow): EvalResultRow {
  return {
    evalRunId: row.eval_run_id,
    caseId: row.case_id,
    repeatIndex: row.repeat_index,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    stageRunId: row.stage_run_id,
    subjectRef: row.subject_ref,
    turns: row.turns,
    toolCallCount: row.tool_call_count,
    output: parse<EvalResultRow["output"]>(row.output_json),
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    score: row.score,
    passed: row.passed !== 0,
    hasGraderErrors: row.has_grader_errors !== 0,
    budgetWarnings: parse<EvalBudgetWarning[]>(row.budget_warnings_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function gradeFromDb(row: EvalGradeDbRow): EvalGradeRow {
  return {
    evalRunId: row.eval_run_id,
    caseId: row.case_id,
    repeatIndex: row.repeat_index,
    graderId: row.grader_id,
    graderType: row.grader_type,
    status: row.status,
    passed: bool(row.passed),
    score: row.score,
    rawValue: row.raw_value,
    reason: row.reason,
    details: parse<EvalGradeRow["details"]>(row.details_json),
    errorCode: row.error_code,
    judgeModel: row.judge_model,
    judgeCostUsd: row.judge_cost_usd,
    judgeTokensIn: row.judge_tokens_in,
    judgeTokensOut: row.judge_tokens_out,
  };
}

function insertGrade(
  db: Database.Database,
  evalRunId: string,
  caseId: string,
  repeatIndex: number,
  grade: EvalGradeInput,
): void {
  db.prepare(
    `INSERT INTO eval_grades
       (eval_run_id, case_id, repeat_index, grader_id, grader_type, status, passed, score, raw_value, reason,
        details_json, error_code, judge_model, judge_cost_usd, judge_tokens_in, judge_tokens_out)
     VALUES
       (@eval_run_id, @case_id, @repeat_index, @grader_id, @grader_type, @status, @passed, @score, @raw_value, @reason,
        @details_json, @error_code, @judge_model, @judge_cost_usd, @judge_tokens_in, @judge_tokens_out)`,
  ).run({
    eval_run_id: evalRunId,
    case_id: caseId,
    repeat_index: repeatIndex,
    grader_id: grade.graderId,
    grader_type: grade.graderType,
    status: grade.status,
    passed: grade.passed === undefined || grade.passed === null ? null : grade.passed ? 1 : 0,
    score: grade.score ?? null,
    raw_value: grade.rawValue ?? null,
    reason: grade.reason ?? null,
    details_json: json(grade.details),
    error_code: grade.errorCode ?? null,
    judge_model: grade.judgeModel ?? null,
    judge_cost_usd: grade.judgeCostUsd ?? null,
    judge_tokens_in: grade.judgeTokensIn ?? null,
    judge_tokens_out: grade.judgeTokensOut ?? null,
  });
}

export function createEvalRun(db: Database.Database, input: CreateEvalRunInput): EvalRunRow {
  const evalRunId = `${EVAL_RUN_ID_PREFIX}${randomBytes(6).toString("hex")}`;
  db.transaction(() => {
    const counter = db
      .prepare(
        `INSERT INTO eval_run_counters (project_root, eval_id, last_number) VALUES (?, ?, 1)
         ON CONFLICT (project_root, eval_id) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number`,
      )
      .get(input.projectRoot, input.evalId) as { last_number: number };
    db.prepare(
      `INSERT INTO eval_runs
         (eval_run_id, project_root, eval_id, run_number, eval_path, eval_hash, target_kind, target_ref_json,
          target_version_hash, dataset_path, dataset_hash, config_json, config_fingerprint, config_components_json,
          status, repeats, pass_threshold, max_cost_usd, cases_total, results_total, engine_name, engine_version,
          stageflow_version, label, started_via, caller_id, created_at)
       VALUES
         (@eval_run_id, @project_root, @eval_id, @run_number, @eval_path, @eval_hash, @target_kind, @target_ref_json,
          @target_version_hash, @dataset_path, @dataset_hash, @config_json, @config_fingerprint, @config_components_json,
          @status, @repeats, @pass_threshold, @max_cost_usd, @cases_total, @results_total, @engine_name, @engine_version,
          @stageflow_version, @label, @started_via, @caller_id, @created_at)`,
    ).run({
      eval_run_id: evalRunId,
      project_root: input.projectRoot,
      eval_id: input.evalId,
      run_number: counter.last_number,
      eval_path: input.evalPath,
      eval_hash: input.evalHash,
      target_kind: input.targetKind,
      target_ref_json: JSON.stringify(input.targetRef),
      target_version_hash: input.targetVersionHash,
      dataset_path: input.datasetPath,
      dataset_hash: input.datasetHash,
      config_json: JSON.stringify(input.config),
      config_fingerprint: input.configFingerprint,
      config_components_json: JSON.stringify(input.configComponents),
      status: input.status ?? "queued",
      repeats: input.repeats,
      pass_threshold: input.passThreshold,
      max_cost_usd: input.maxCostUsd,
      cases_total: input.casesTotal,
      results_total: input.resultsTotal,
      engine_name: input.engineName,
      engine_version: input.engineVersion,
      stageflow_version: input.stageflowVersion,
      label: input.label ?? null,
      started_via: input.startedVia,
      caller_id: input.callerId ?? null,
      created_at: now(),
    });
  })();
  return getEvalRun(db, evalRunId)!;
}

export function insertEvalCases(db: Database.Database, evalRunId: string, cases: EvalCaseInput[]): void {
  const insert = db.prepare(
    `INSERT INTO eval_cases (eval_run_id, case_id, position, case_json) VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const c of cases) insert.run(evalRunId, c.caseId, c.position, JSON.stringify(c.case));
  })();
}

export function upsertEvalResult(db: Database.Database, input: EvalResultInput): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO eval_results
         (eval_run_id, case_id, repeat_index, status, error_code, error_message, stage_run_id, subject_ref, turns, tool_call_count, output_json, latency_ms,
          cost_usd, tokens_in, tokens_out, score, passed, has_grader_errors, budget_warnings_json, started_at, finished_at)
       VALUES
         (@eval_run_id, @case_id, @repeat_index, @status, @error_code, @error_message, @stage_run_id, @subject_ref, @turns, @tool_call_count, @output_json, @latency_ms,
          @cost_usd, @tokens_in, @tokens_out, @score, @passed, @has_grader_errors, @budget_warnings_json, @started_at, @finished_at)
       ON CONFLICT (eval_run_id, case_id, repeat_index) DO UPDATE SET
         status = excluded.status, error_code = excluded.error_code, error_message = excluded.error_message,
         stage_run_id = excluded.stage_run_id, subject_ref = excluded.subject_ref, turns = excluded.turns,
         tool_call_count = excluded.tool_call_count, output_json = excluded.output_json, latency_ms = excluded.latency_ms,
         cost_usd = excluded.cost_usd, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
         score = excluded.score, passed = excluded.passed, has_grader_errors = excluded.has_grader_errors,
         budget_warnings_json = excluded.budget_warnings_json, started_at = excluded.started_at,
         finished_at = excluded.finished_at`,
    ).run({
      eval_run_id: input.evalRunId,
      case_id: input.caseId,
      repeat_index: input.repeatIndex,
      status: input.status,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      stage_run_id: input.stageRunId ?? null,
      subject_ref: input.subjectRef ?? input.stageRunId ?? null,
      turns: input.turns ?? null,
      tool_call_count: input.toolCallCount ?? null,
      output_json: json(input.output),
      latency_ms: input.latencyMs ?? null,
      cost_usd: input.costUsd ?? null,
      tokens_in: input.tokensIn ?? null,
      tokens_out: input.tokensOut ?? null,
      score: input.score ?? null,
      passed: input.passed ? 1 : 0,
      has_grader_errors: input.hasGraderErrors ? 1 : 0,
      budget_warnings_json: json(input.budgetWarnings),
      started_at: input.startedAt ?? null,
      finished_at: input.finishedAt ?? null,
    });
    db.prepare(`DELETE FROM eval_grades WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ?`).run(
      input.evalRunId,
      input.caseId,
      input.repeatIndex,
    );
    for (const grade of input.grades ?? []) {
      insertGrade(db, input.evalRunId, input.caseId, input.repeatIndex, grade);
    }
  })();
}

export function updateEvalRunProgress(db: Database.Database, evalRunId: string, progress: EvalRunProgress): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { eval_run_id: evalRunId };
  if (progress.resultsDone !== undefined) {
    sets.push("results_done = @results_done");
    params.results_done = progress.resultsDone;
  }
  if (progress.costUsd !== undefined) {
    sets.push("cost_usd = @cost_usd");
    params.cost_usd = progress.costUsd;
  }
  if (progress.status !== undefined) {
    sets.push("status = @status");
    params.status = progress.status;
  }
  if (progress.statusReason !== undefined) {
    sets.push("status_reason = @status_reason");
    params.status_reason = progress.statusReason;
  }
  if (progress.startedAt !== undefined) {
    sets.push("started_at = @started_at");
    params.started_at = progress.startedAt;
  }
  if (sets.length === 0) return;
  const result = db.prepare(`UPDATE eval_runs SET ${sets.join(", ")} WHERE eval_run_id = @eval_run_id`).run(params);
  if (result.changes === 0) throw notFound(evalRunId);
}

export function finishEvalRun(db: Database.Database, evalRunId: string, input: FinishEvalRunInput): void {
  const result = db
    .prepare(
      `UPDATE eval_runs SET status = @status, status_reason = @status_reason, passed = @passed,
         summary_json = @summary_json, finished_at = @finished_at WHERE eval_run_id = @eval_run_id`,
    )
    .run({
      eval_run_id: evalRunId,
      status: input.status,
      status_reason: input.statusReason ?? null,
      passed: input.passed ? 1 : 0,
      summary_json: JSON.stringify(input.summary),
      finished_at: input.finishedAt,
    });
  if (result.changes === 0) throw notFound(evalRunId);
}

function notFound(evalRunId: string): EvalStoreError {
  return new EvalStoreError("EVAL_RUN_NOT_FOUND", `Eval run not found: ${evalRunId}`);
}

export function getEvalRun(db: Database.Database, evalRunId: string): EvalRunRow | null {
  const row = db.prepare(`SELECT * FROM eval_runs WHERE eval_run_id = ?`).get(evalRunId) as EvalRunDbRow | undefined;
  return row ? runFromDb(row) : null;
}

export function getEvalRunByNumber(
  db: Database.Database,
  projectRoot: string,
  evalId: string,
  runNumber: number,
): EvalRunRow | null {
  const row = db
    .prepare(`SELECT * FROM eval_runs WHERE project_root = ? AND eval_id = ? AND run_number = ?`)
    .get(projectRoot, evalId, runNumber) as EvalRunDbRow | undefined;
  return row ? runFromDb(row) : null;
}

export function listEvalRuns(db: Database.Database, query: ListEvalRunsQuery): EvalRunPage {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.projectRoot !== undefined) {
    clauses.push("project_root = ?");
    params.push(query.projectRoot);
  }
  if (query.evalId !== undefined) {
    clauses.push("eval_id = ?");
    params.push(query.evalId);
  }
  if (query.status !== undefined) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  if (query.stageRunId !== undefined) {
    clauses.push("eval_run_id IN (SELECT eval_run_id FROM eval_results WHERE stage_run_id = ?)");
    params.push(query.stageRunId);
  }
  if (query.subjectRef !== undefined) {
    clauses.push("eval_run_id IN (SELECT eval_run_id FROM eval_results WHERE subject_ref = ?)");
    params.push(query.subjectRef);
  }
  if (query.cursor !== undefined) {
    const [createdAt, id] = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as [string, string];
    clauses.push("(created_at < ? OR (created_at = ? AND eval_run_id < ?))");
    params.push(createdAt, createdAt, id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM eval_runs ${where} ORDER BY created_at DESC, eval_run_id DESC LIMIT ?`)
    .all(...params, query.limit + 1) as EvalRunDbRow[];
  const page = rows.slice(0, query.limit).map(runFromDb);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > query.limit && last
      ? Buffer.from(JSON.stringify([last.createdAt, last.evalRunId]), "utf8").toString("base64url")
      : null;
  return { items: page, nextCursor };
}

function attachGrades(db: Database.Database, results: EvalResultRow[], evalRunId: string, caseId?: string): EvalResultWithGrades[] {
  const grades = db
    .prepare(
      `SELECT * FROM eval_grades WHERE eval_run_id = ? ${caseId !== undefined ? "AND case_id = ?" : ""}
       ORDER BY case_id, repeat_index, rowid`,
    )
    .all(...(caseId !== undefined ? [evalRunId, caseId] : [evalRunId])) as EvalGradeDbRow[];
  const byResult = new Map<string, EvalGradeRow[]>();
  for (const grade of grades.map(gradeFromDb)) {
    const key = `${grade.caseId}\u0000${grade.repeatIndex}`;
    const list = byResult.get(key);
    if (list) list.push(grade);
    else byResult.set(key, [grade]);
  }
  return results.map((result) => ({
    ...result,
    grades: byResult.get(`${result.caseId}\u0000${result.repeatIndex}`) ?? [],
  }));
}

export function listEvalResults(db: Database.Database, evalRunId: string): EvalResultWithGrades[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM eval_results r JOIN eval_cases c ON c.eval_run_id = r.eval_run_id AND c.case_id = r.case_id
       WHERE r.eval_run_id = ? ORDER BY c.position, r.repeat_index`,
    )
    .all(evalRunId) as EvalResultDbRow[];
  return attachGrades(db, rows.map(resultFromDb), evalRunId);
}

/** Keys of the results one grader graded in a run, without their outputs. */
export function listGradedResultKeys(
  db: Database.Database,
  evalRunId: string,
  graderId: string,
): Array<{ caseId: string; repeatIndex: number }> {
  return (
    db
      .prepare(
        `SELECT DISTINCT case_id, repeat_index FROM eval_grades
          WHERE eval_run_id = ? AND grader_id = ? AND status = 'graded' ORDER BY case_id, repeat_index`,
      )
      .all(evalRunId, graderId) as Array<{ case_id: string; repeat_index: number }>
  ).map((r) => ({ caseId: r.case_id, repeatIndex: r.repeat_index }));
}

export function getEvalResultsForCase(
  db: Database.Database,
  evalRunId: string,
  caseId: string,
): EvalResultWithGrades[] {
  const rows = db
    .prepare(`SELECT * FROM eval_results WHERE eval_run_id = ? AND case_id = ? ORDER BY repeat_index`)
    .all(evalRunId, caseId) as EvalResultDbRow[];
  return attachGrades(db, rows.map(resultFromDb), evalRunId, caseId);
}

export function getEvalCases(db: Database.Database, evalRunId: string): EvalCaseRow[] {
  const rows = db
    .prepare(`SELECT eval_run_id, case_id, position, case_json FROM eval_cases WHERE eval_run_id = ? ORDER BY position`)
    .all(evalRunId) as Array<{ eval_run_id: string; case_id: string; position: number; case_json: string }>;
  return rows.map((row) => ({
    evalRunId: row.eval_run_id,
    caseId: row.case_id,
    position: row.position,
    case: JSON.parse(row.case_json) as EvalCaseRow["case"],
  }));
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const name = raw.trim();
    if (name.length < 1 || name.length > EVAL_LIMITS.failureTypeNameMaxChars) {
      throw new Error(`Failure type must be 1-${EVAL_LIMITS.failureTypeNameMaxChars} characters`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function putEvalReview(
  db: Database.Database,
  evalRunId: string,
  caseId: string,
  repeatIndex: number,
  patch: EvalReviewPatch,
): EvalReviewRow {
  if (typeof patch.note === "string" && patch.note.length > EVAL_LIMITS.reviewNoteMaxChars) {
    throw new Error(`Review note must be at most ${EVAL_LIMITS.reviewNoteMaxChars} characters`);
  }
  const tags = patch.tags === undefined ? undefined : normalizeTags(patch.tags);
  db.transaction(() => {
    const result = db
      .prepare(
        `SELECT r.passed, e.project_root, e.eval_id FROM eval_results r JOIN eval_runs e ON e.eval_run_id = r.eval_run_id
         WHERE r.eval_run_id = ? AND r.case_id = ? AND r.repeat_index = ?`,
      )
      .get(evalRunId, caseId, repeatIndex) as { passed: number; project_root: string; eval_id: string } | undefined;
    if (!result) {
      throw new EvalStoreError(
        "EVAL_RUN_NOT_FOUND",
        `Eval result not found: ${evalRunId}/${caseId}/${repeatIndex}`,
      );
    }
    if (tags !== undefined && tags.length > 0 && result.passed !== 0) {
      throw new EvalStoreError("EVAL_TAGS_ON_PASSED_RESULT", "Failure types apply only to results marked failed");
    }
    const at = now();
    const existing = db
      .prepare(`SELECT 1 AS ok FROM eval_result_reviews WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ?`)
      .get(evalRunId, caseId, repeatIndex);
    if (patch.label !== undefined) {
      db.prepare(
        `INSERT INTO eval_result_reviews (eval_run_id, case_id, repeat_index, label, note, created_at, updated_at)
         VALUES (@eval_run_id, @case_id, @repeat_index, @label, @note, @at, @at)
         ON CONFLICT (eval_run_id, case_id, repeat_index) DO UPDATE SET
           label = excluded.label,
           note = ${patch.note === undefined ? "eval_result_reviews.note" : "excluded.note"},
           updated_at = excluded.updated_at`,
      ).run({
        eval_run_id: evalRunId,
        case_id: caseId,
        repeat_index: repeatIndex,
        label: patch.label,
        note: patch.note ?? null,
        at,
      });
    } else if (patch.note !== undefined) {
      if (existing) {
        db.prepare(
          `UPDATE eval_result_reviews SET note = ?, updated_at = ? WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ?`,
        ).run(patch.note, at, evalRunId, caseId, repeatIndex);
      } else if (patch.note !== null) {
        throw new Error("A review note needs a pass or fail label");
      }
    }
    if (tags !== undefined) {
      const keep = new Set(tags.map((t) => t.toLowerCase()));
      const current = db
        .prepare(`SELECT tag FROM eval_result_tags WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ?`)
        .all(evalRunId, caseId, repeatIndex) as Array<{ tag: string }>;
      const have = new Set(current.map((row) => row.tag.toLowerCase()));
      for (const row of current) {
        if (!keep.has(row.tag.toLowerCase())) {
          db.prepare(
            `DELETE FROM eval_result_tags WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ? AND tag = ?`,
          ).run(evalRunId, caseId, repeatIndex, row.tag);
        }
      }
      for (const tag of tags) {
        db.prepare(
          `INSERT INTO eval_failure_types (project_root, eval_id, name, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).run(result.project_root, result.eval_id, tag, at);
        if (!have.has(tag.toLowerCase())) {
          db.prepare(
            `INSERT INTO eval_result_tags (eval_run_id, case_id, repeat_index, tag, created_at) VALUES (?, ?, ?, ?, ?)`,
          ).run(evalRunId, caseId, repeatIndex, tag, at);
        }
      }
    }
  })();
  return readReview(db, evalRunId, caseId, repeatIndex);
}

function readReview(db: Database.Database, evalRunId: string, caseId: string, repeatIndex: number): EvalReviewRow {
  return (
    getEvalReviews(db, evalRunId).find((r) => r.caseId === caseId && r.repeatIndex === repeatIndex) ?? {
      evalRunId,
      caseId,
      repeatIndex,
      label: null,
      note: null,
      tags: [],
      createdAt: null,
      updatedAt: null,
    }
  );
}

export function getEvalReviews(db: Database.Database, evalRunId: string): EvalReviewRow[] {
  const reviews = db
    .prepare(
      `SELECT case_id, repeat_index, label, note, created_at, updated_at FROM eval_result_reviews WHERE eval_run_id = ?`,
    )
    .all(evalRunId) as Array<{
    case_id: string;
    repeat_index: number;
    label: EvalReviewRow["label"];
    note: string | null;
    created_at: string;
    updated_at: string;
  }>;
  const tagRows = db
    .prepare(
      `SELECT case_id, repeat_index, tag FROM eval_result_tags WHERE eval_run_id = ? ORDER BY created_at, rowid`,
    )
    .all(evalRunId) as Array<{ case_id: string; repeat_index: number; tag: string }>;
  const merged = new Map<string, EvalReviewRow>();
  const keyOf = (caseId: string, repeat: number): string => `${caseId}\u0000${repeat}`;
  for (const r of reviews) {
    merged.set(keyOf(r.case_id, r.repeat_index), {
      evalRunId,
      caseId: r.case_id,
      repeatIndex: r.repeat_index,
      label: r.label,
      note: r.note,
      tags: [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  for (const t of tagRows) {
    const key = keyOf(t.case_id, t.repeat_index);
    let row = merged.get(key);
    if (!row) {
      row = {
        evalRunId,
        caseId: t.case_id,
        repeatIndex: t.repeat_index,
        label: null,
        note: null,
        tags: [],
        createdAt: null,
        updatedAt: null,
      };
      merged.set(key, row);
    }
    row.tags.push(t.tag);
  }
  return [...merged.values()].sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeatIndex - b.repeatIndex);
}

export function listFailureTypes(db: Database.Database, projectRoot: string, evalId: string): string[] {
  const rows = db
    .prepare(
      `SELECT ft.name AS name FROM eval_failure_types ft
       WHERE ft.project_root = ? AND ft.eval_id = ?
       ORDER BY COALESCE(
         (SELECT MAX(t.created_at) FROM eval_result_tags t JOIN eval_runs r ON r.eval_run_id = t.eval_run_id
          WHERE r.project_root = ft.project_root AND r.eval_id = ft.eval_id AND t.tag = ft.name COLLATE NOCASE),
         ft.created_at) DESC, ft.rowid DESC`,
    )
    .all(projectRoot, evalId) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function recordGraderVersions(
  db: Database.Database,
  projectRoot: string,
  evalId: string,
  graders: EvalGraderVersionInput[],
): Record<string, number> {
  const out: Record<string, number> = {};
  db.transaction(() => {
    for (const { graderId, graderHash } of graders) {
      const existing = db
        .prepare(
          `SELECT ordinal FROM eval_grader_versions WHERE project_root = ? AND eval_id = ? AND grader_id = ? AND grader_hash = ?`,
        )
        .get(projectRoot, evalId, graderId, graderHash) as { ordinal: number } | undefined;
      if (existing) {
        out[graderId] = existing.ordinal;
        continue;
      }
      const max = db
        .prepare(`SELECT MAX(ordinal) AS m FROM eval_grader_versions WHERE project_root = ? AND eval_id = ? AND grader_id = ?`)
        .get(projectRoot, evalId, graderId) as { m: number | null };
      const ordinal = (max.m ?? 0) + 1;
      db.prepare(
        `INSERT INTO eval_grader_versions (project_root, eval_id, grader_id, grader_hash, ordinal, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectRoot, evalId, graderId, graderHash, ordinal, now());
      out[graderId] = ordinal;
    }
  })();
  return out;
}

export function listEvalSubjectRefs(db: Database.Database, evalRunId: string, targetKind: EvalTargetKind): string[] {
  const run = getEvalRun(db, evalRunId);
  if (!run || run.targetKind !== targetKind) return [];
  return (
    db
      .prepare(
        `SELECT DISTINCT subject_ref FROM eval_results WHERE eval_run_id = ? AND subject_ref IS NOT NULL ORDER BY subject_ref`,
      )
      .all(evalRunId) as Array<{ subject_ref: string }>
  ).map((row) => row.subject_ref);
}

export function deleteEvalRun(db: Database.Database, evalRunId: string): string[] {
  let stageRunIds: string[] = [];
  db.transaction(() => {
    if (!getEvalRun(db, evalRunId)) throw notFound(evalRunId);
    stageRunIds = (
      db
        .prepare(
          `SELECT DISTINCT stage_run_id FROM eval_results WHERE eval_run_id = ? AND stage_run_id IS NOT NULL ORDER BY stage_run_id`,
        )
        .all(evalRunId) as Array<{ stage_run_id: string }>
    ).map((row) => row.stage_run_id);
    db.prepare(`DELETE FROM eval_runs WHERE eval_run_id = ?`).run(evalRunId);
  })();
  return stageRunIds;
}
