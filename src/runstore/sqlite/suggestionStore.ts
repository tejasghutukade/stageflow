import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { EvalStoreError } from "../../evals/storeError.js";
import { BUCKET_TAG_PREFIX } from "../../evals/triage/constants.js";
import type { SuggestionInput, SuggestionRow } from "../../evals/triage/types.js";
import { getEvalReviews, putEvalReview } from "./evalStore.js";

type SuggestionDbRow = {
  id: string;
  eval_run_id: string;
  case_id: string;
  repeat_index: number;
  source: SuggestionRow["source"];
  bucket: SuggestionRow["bucket"];
  failure_type: string | null;
  confidence: number;
  probabilities_json: string;
  grader_false_alarms_json: string;
  model: string;
  prompt_version: number;
  status: SuggestionRow["status"];
  batch_id: string;
  cost_usd: number;
  state_truncated: number;
  created_at: string;
};

const now = (): string => new Date().toISOString();

function suggestionFromDb(row: SuggestionDbRow): SuggestionRow {
  return {
    id: row.id,
    evalRunId: row.eval_run_id,
    caseId: row.case_id,
    repeatIndex: row.repeat_index,
    source: row.source,
    bucket: row.bucket,
    failureType: row.failure_type,
    confidence: row.confidence,
    bucketProbabilities: JSON.parse(row.probabilities_json) as SuggestionRow["bucketProbabilities"],
    graderFalseAlarms: JSON.parse(row.grader_false_alarms_json) as SuggestionRow["graderFalseAlarms"],
    model: row.model,
    promptVersion: row.prompt_version,
    status: row.status,
    batchId: row.batch_id,
    costUsd: row.cost_usd,
    stateTruncated: row.state_truncated === 1,
    createdAt: row.created_at,
  };
}

/** Inserts or replaces pending suggestions; accepted and dismissed ones are kept. Returns the rows this call wrote. */
export function upsertEvalSuggestions(
  db: Database.Database,
  evalRunId: string,
  inputs: SuggestionInput[],
): SuggestionRow[] {
  const written: SuggestionRow[] = [];
  const at = now();
  db.transaction(() => {
    for (const input of inputs) {
      const info = db
        .prepare(
          `INSERT INTO eval_result_suggestions
             (id, eval_run_id, case_id, repeat_index, source, bucket, failure_type, confidence, probabilities_json,
              grader_false_alarms_json, model, prompt_version, status, batch_id, cost_usd, state_truncated, created_at)
           VALUES (@id, @eval_run_id, @case_id, @repeat_index, @source, @bucket, @failure_type, @confidence, @probabilities_json,
              @grader_false_alarms_json, @model, @prompt_version, 'pending', @batch_id, @cost_usd, @state_truncated, @at)
           ON CONFLICT (eval_run_id, case_id, repeat_index, source) DO UPDATE SET
             bucket = excluded.bucket, failure_type = excluded.failure_type, confidence = excluded.confidence,
             probabilities_json = excluded.probabilities_json, grader_false_alarms_json = excluded.grader_false_alarms_json,
             model = excluded.model, prompt_version = excluded.prompt_version, batch_id = excluded.batch_id,
             cost_usd = excluded.cost_usd, state_truncated = excluded.state_truncated, created_at = excluded.created_at
           WHERE eval_result_suggestions.status = 'pending'`,
        )
        .run({
          id: `sg_${randomBytes(8).toString("hex")}`,
          eval_run_id: evalRunId,
          case_id: input.caseId,
          repeat_index: input.repeatIndex,
          source: input.source,
          bucket: input.bucket,
          failure_type: input.failureType,
          confidence: input.confidence,
          probabilities_json: JSON.stringify(input.bucketProbabilities),
          grader_false_alarms_json: JSON.stringify(input.graderFalseAlarms),
          model: input.model,
          prompt_version: input.promptVersion,
          batch_id: input.batchId,
          cost_usd: input.costUsd,
          state_truncated: input.stateTruncated ? 1 : 0,
          at,
        });
      if (info.changes === 0) continue;
      const row = db
        .prepare(
          `SELECT * FROM eval_result_suggestions WHERE eval_run_id = ? AND case_id = ? AND repeat_index = ? AND source = ?`,
        )
        .get(evalRunId, input.caseId, input.repeatIndex, input.source) as SuggestionDbRow;
      written.push(suggestionFromDb(row));
    }
  })();
  return written;
}

export function listEvalSuggestions(
  db: Database.Database,
  evalRunId: string,
  status?: SuggestionRow["status"],
): SuggestionRow[] {
  const rows = (
    status !== undefined
      ? db
          .prepare(`SELECT * FROM eval_result_suggestions WHERE eval_run_id = ? AND status = ? ORDER BY case_id, repeat_index, source`)
          .all(evalRunId, status)
      : db
          .prepare(`SELECT * FROM eval_result_suggestions WHERE eval_run_id = ? ORDER BY case_id, repeat_index, source`)
          .all(evalRunId)
  ) as SuggestionDbRow[];
  return rows.map(suggestionFromDb);
}

export function dismissEvalSuggestions(db: Database.Database, evalRunId: string, ids: string[]): number {
  let changed = 0;
  db.transaction(() => {
    for (const id of ids) {
      changed += db
        .prepare(`UPDATE eval_result_suggestions SET status = 'dismissed' WHERE eval_run_id = ? AND id = ? AND status = 'pending'`)
        .run(evalRunId, id).changes;
    }
  })();
  return changed;
}

/**
 * Marks pending suggestions accepted and adds their failure type and `bucket:<bucket>` tags to the result
 * through `putEvalReview`, keeping tags already there. Returns how many were accepted and how many results gained a tag.
 */
export function acceptEvalSuggestions(
  db: Database.Database,
  evalRunId: string,
  ids: string[],
): { accepted: number; tagged: number } {
  let accepted = 0;
  let tagged = 0;
  db.transaction(() => {
    for (const id of ids) {
      const found = db
        .prepare(`SELECT * FROM eval_result_suggestions WHERE eval_run_id = ? AND id = ? AND status = 'pending'`)
        .get(evalRunId, id) as SuggestionDbRow | undefined;
      if (found === undefined) continue;
      const suggestion = suggestionFromDb(found);
      const add = [
        ...(suggestion.failureType !== null ? [suggestion.failureType] : []),
        `${BUCKET_TAG_PREFIX}${suggestion.bucket}`,
      ];
      const have =
        getEvalReviews(db, evalRunId).find(
          (r) => r.caseId === suggestion.caseId && r.repeatIndex === suggestion.repeatIndex,
        )?.tags ?? [];
      const haveKeys = new Set(have.map((t) => t.toLowerCase()));
      const fresh = add.filter((t) => !haveKeys.has(t.toLowerCase()));
      if (fresh.length > 0) {
        try {
          putEvalReview(db, evalRunId, suggestion.caseId, suggestion.repeatIndex, { tags: [...have, ...fresh] });
          tagged += 1;
        } catch (err) {
          if (err instanceof EvalStoreError && err.code === "EVAL_TAGS_ON_PASSED_RESULT") continue;
          throw err;
        }
      }
      db.prepare(`UPDATE eval_result_suggestions SET status = 'accepted' WHERE id = ?`).run(id);
      accepted += 1;
    }
  })();
  return { accepted, tagged };
}
