import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { EVAL_LIMITS } from "../../evals/constants.js";
import { EvalStoreError } from "../../evals/storeError.js";
import type {
  EvalCalibrationDisagreement,
  EvalCalibrationInput,
  EvalCalibrationRow,
  EvalGraderLabelPatch,
  EvalGraderLabelRow,
  EvalJson,
} from "../../evals/storeTypes.js";

type LabelDbRow = {
  eval_run_id: string;
  case_id: string;
  repeat_index: number;
  grader_id: string;
  label: "pass" | "fail";
  note: string | null;
  created_at: string;
  updated_at: string;
};

type CalibrationDbRow = {
  id: string;
  project_root: string;
  eval_id: string;
  grader_id: string;
  grader_hash: string;
  judge: string;
  prompt_version: number;
  split: EvalCalibrationRow["split"];
  candidate: number;
  stats_json: string;
  disagreements_json: string;
  cost_usd: number;
  created_at: string;
};

const now = (): string => new Date().toISOString();

const labelFromDb = (r: LabelDbRow): EvalGraderLabelRow => ({
  evalRunId: r.eval_run_id,
  caseId: r.case_id,
  repeatIndex: r.repeat_index,
  graderId: r.grader_id,
  label: r.label,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Sets, changes or (label null) clears one grader label on a stored result. */
export function putEvalGraderLabel(
  db: Database.Database,
  evalRunId: string,
  caseId: string,
  repeatIndex: number,
  graderId: string,
  patch: EvalGraderLabelPatch,
): EvalGraderLabelRow | null {
  if (typeof patch.note === "string" && patch.note.length > EVAL_LIMITS.reviewNoteMaxChars) {
    throw new Error(`Label note must be at most ${EVAL_LIMITS.reviewNoteMaxChars} characters`);
  }
  const exists = db
    .prepare(`SELECT 1 AS ok FROM eval_results WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ?`)
    .get(evalRunId, caseId, repeatIndex);
  if (!exists) throw new EvalStoreError("EVAL_RUN_NOT_FOUND", `No result for ${caseId}#${repeatIndex} in ${evalRunId}`);
  if (patch.label === null) {
    db.prepare(
      `DELETE FROM eval_grader_labels WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ? AND grader_id = ?`,
    ).run(evalRunId, caseId, repeatIndex, graderId);
    return null;
  }
  const at = now();
  db.prepare(
    `INSERT INTO eval_grader_labels (eval_run_id, case_id, repeat_index, grader_id, label, note, created_at, updated_at)
     VALUES (@run, @case, @repeat, @grader, @label, @note, @at, @at)
     ON CONFLICT (eval_run_id, case_id, repeat_index, grader_id) DO UPDATE SET
       label = excluded.label,
       note = ${patch.note === undefined ? "eval_grader_labels.note" : "excluded.note"},
       updated_at = excluded.updated_at`,
  ).run({
    run: evalRunId,
    case: caseId,
    repeat: repeatIndex,
    grader: graderId,
    label: patch.label,
    note: patch.note ?? null,
    at,
  });
  return labelFromDb(
    db
      .prepare(
        `SELECT * FROM eval_grader_labels WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ? AND grader_id = ?`,
      )
      .get(evalRunId, caseId, repeatIndex, graderId) as LabelDbRow,
  );
}

export function listEvalGraderLabels(db: Database.Database, evalRunId: string): EvalGraderLabelRow[] {
  return (
    db
      .prepare(`SELECT * FROM eval_grader_labels WHERE eval_run_id = ? ORDER BY case_id, repeat_index, grader_id`)
      .all(evalRunId) as LabelDbRow[]
  ).map(labelFromDb);
}

/** Labels across every run of one eval, newest label first. */
export function listEvalGraderLabelsForEval(
  db: Database.Database,
  projectRoot: string,
  evalId: string,
  graderId: string,
): EvalGraderLabelRow[] {
  return (
    db
      .prepare(
        `SELECT l.* FROM eval_grader_labels l
           JOIN eval_runs r ON r.eval_run_id = l.eval_run_id
          WHERE r.project_root = ? AND r.eval_id = ? AND l.grader_id = ?
          ORDER BY l.updated_at DESC, l.eval_run_id, l.case_id, l.repeat_index`,
      )
      .all(projectRoot, evalId, graderId) as LabelDbRow[]
  ).map(labelFromDb);
}

const calibrationFromDb = (r: CalibrationDbRow): EvalCalibrationRow => ({
  id: r.id,
  projectRoot: r.project_root,
  evalId: r.eval_id,
  graderId: r.grader_id,
  graderHash: r.grader_hash,
  judge: r.judge,
  promptVersion: r.prompt_version,
  split: r.split,
  candidate: r.candidate === 1,
  stats: JSON.parse(r.stats_json) as EvalJson,
  disagreements: JSON.parse(r.disagreements_json) as EvalCalibrationDisagreement[],
  costUsd: r.cost_usd,
  createdAt: r.created_at,
});

export function insertEvalCalibration(db: Database.Database, input: EvalCalibrationInput): EvalCalibrationRow {
  const id = `cal_${randomBytes(6).toString("hex")}`;
  const createdAt = now();
  db.prepare(
    `INSERT INTO eval_calibrations
       (id, project_root, eval_id, grader_id, grader_hash, judge, prompt_version, split, candidate, stats_json, disagreements_json, cost_usd, created_at)
     VALUES (@id, @project_root, @eval_id, @grader_id, @grader_hash, @judge, @prompt_version, @split, @candidate, @stats_json, @disagreements_json, @cost_usd, @created_at)`,
  ).run({
    id,
    project_root: input.projectRoot,
    eval_id: input.evalId,
    grader_id: input.graderId,
    grader_hash: input.graderHash,
    judge: input.judge,
    prompt_version: input.promptVersion,
    split: input.split,
    candidate: input.candidate ? 1 : 0,
    stats_json: JSON.stringify(input.stats),
    disagreements_json: JSON.stringify(input.disagreements),
    cost_usd: input.costUsd,
    created_at: createdAt,
  });
  return { ...input, id, createdAt };
}

/** Newest first. Candidate (unsaved-rubric) calibrations are included only on request. */
export function listEvalCalibrations(
  db: Database.Database,
  projectRoot: string,
  evalId: string,
  graderId?: string,
  includeCandidates = false,
  limit = 20,
): EvalCalibrationRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM eval_calibrations
          WHERE project_root = ? AND eval_id = ? AND (? IS NULL OR grader_id = ?) AND (candidate = 0 OR ?)
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectRoot, evalId, graderId ?? null, graderId ?? null, includeCandidates ? 1 : 0, limit) as CalibrationDbRow[]
  ).map(calibrationFromDb);
}
