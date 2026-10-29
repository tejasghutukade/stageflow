import type { RunStore } from "../../runstore/port.js";
import type { EvalGradeRow } from "../storeTypes.js";
import { resultKey } from "../statsTypes.js";
import { EvalApiError, runByIdOr404 } from "./api.js";
import { resultToWire } from "./runs.js";

const JUDGED_TYPES = new Set(["rubric", "goal_reached"]);

export type LabelCounts = { pass: number; fail: number };

/**
 * Everything the console's labeling screen needs in one read: each result the judge graded for one grader, with the
 * conversation, what the case expects, the judge's answer and the author's label so far. Results the judge errored on
 * are left out (there is no verdict to compare with), and so are results that never ran.
 */
export async function buildLabelQueue(store: RunStore, id: string, graderId: string) {
  const row = await runByIdOr404(store, id);
  const [cases, results, labels, evalLabels] = await Promise.all([
    store.getEvalCases(row.evalRunId),
    store.listEvalResults(row.evalRunId),
    store.listEvalGraderLabels(row.evalRunId),
    store.listEvalGraderLabelsForEval(row.projectRoot, row.evalId, graderId),
  ]);
  const caseById = new Map(cases.map((c) => [c.caseId, c]));
  const labelByKey = new Map(
    labels.filter((l) => l.graderId === graderId).map((l) => [resultKey(l.caseId, l.repeatIndex), l]),
  );
  const gradeOf = (grades: EvalGradeRow[]) => grades.find((g) => g.graderId === graderId);
  const known = results.some((r) => gradeOf(r.grades) !== undefined);
  if (!known) {
    throw new EvalApiError(404, "EVAL_RUN_NOT_FOUND", `Grader ${graderId} has no grades in run ${id}`);
  }
  const judged = results.find((r) => {
    const g = gradeOf(r.grades);
    return g !== undefined && JUDGED_TYPES.has(g.graderType);
  });
  if (!judged) {
    throw new EvalApiError(400, "invalid_request", `Grader ${graderId} is not judged by a model, so it has nothing to label`);
  }
  const items = [...results]
    .sort((a, b) => (caseById.get(a.caseId)?.position ?? 0) - (caseById.get(b.caseId)?.position ?? 0) || a.repeatIndex - b.repeatIndex)
    .flatMap((r) => {
      const grade = gradeOf(r.grades);
      const caseRow = caseById.get(r.caseId);
      if (!grade || grade.status !== "graded" || !caseRow) return [];
      const label = labelByKey.get(resultKey(r.caseId, r.repeatIndex));
      return [
        {
          case: { ...caseRow.case, position: caseRow.position },
          result: resultToWire(r, undefined),
          judge: { passed: grade.passed === true, score: grade.score, reason: grade.reason },
          label: label ? { label: label.label, note: label.note } : null,
        },
      ];
    });
  const count = (rows: Array<{ label: "pass" | "fail" }>): LabelCounts => ({
    pass: rows.filter((l) => l.label === "pass").length,
    fail: rows.filter((l) => l.label === "fail").length,
  });
  return {
    grader_id: graderId,
    items,
    labeled_here: count(labels.filter((l) => l.graderId === graderId)),
    labeled_eval: count(evalLabels),
  };
}

/**
 * The label counts across the eval's runs, and which results of this run the judge graded that still have no label
 * from you. No conversations: this is for a progress line and the Cases filter.
 */
export async function buildLabelSummary(store: RunStore, id: string, graderId: string) {
  const row = await runByIdOr404(store, id);
  const [labels, runLabels, results] = await Promise.all([
    store.listEvalGraderLabelsForEval(row.projectRoot, row.evalId, graderId),
    store.listEvalGraderLabels(row.evalRunId),
    store.listEvalResults(row.evalRunId),
  ]);
  const labeled = new Set(runLabels.filter((l) => l.graderId === graderId).map((l) => resultKey(l.caseId, l.repeatIndex)));
  const unlabeled = results
    .filter((r) => r.grades.some((g) => g.graderId === graderId && g.status === "graded"))
    .filter((r) => !labeled.has(resultKey(r.caseId, r.repeatIndex)))
    .map((r) => ({ case_id: r.caseId, repeat_index: r.repeatIndex }));
  return {
    grader_id: graderId,
    labeled_eval: {
      pass: labels.filter((l) => l.label === "pass").length,
      fail: labels.filter((l) => l.label === "fail").length,
    },
    unlabeled,
  };
}
