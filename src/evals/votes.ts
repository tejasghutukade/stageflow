import type { NormalizedGrade } from "./types.js";

export const JUDGE_ERROR_CODE = "EVAL_JUDGE_ERROR";

/**
 * One grade from several votes: the majority verdict for pass/fail (a tie fails), the mean raw score for 1 to 5.
 * Errored votes are left out; if every vote errored the grade is an error. Tokens and cost add up over all votes.
 */
export function combineVotes(
  grader: { scale: "pass_fail" | "1_to_5"; passAt: number },
  votes: readonly NormalizedGrade[],
): NormalizedGrade {
  const first = votes[0]!;
  if (votes.length === 1) return first;
  const valid = votes.filter((g) => g.status === "graded" && g.passed !== undefined);
  const sum = (pick: (g: NormalizedGrade) => number | undefined): number =>
    votes.reduce((total, g) => total + (pick(g) ?? 0), 0);
  const totals = {
    judgeTokensIn: sum((g) => g.judgeTokensIn),
    judgeTokensOut: sum((g) => g.judgeTokensOut),
    judgeCostUsd: sum((g) => g.judgeCostUsd),
  };
  const priceUnknown = votes.some((g) => (g.details as { judgeCostUnknown?: boolean } | undefined)?.judgeCostUnknown);
  const record = votes.map((g) => ({
    status: g.status,
    ...(g.passed !== undefined ? { passed: g.passed } : {}),
    ...(g.rawValue !== undefined ? { raw_value: g.rawValue } : {}),
    ...(g.reason !== undefined ? { reason: g.reason } : {}),
  }));
  const baseDetails = {
    ...((first.details as Record<string, unknown> | undefined) ?? {}),
    ...(priceUnknown ? { judgeCostUnknown: true } : {}),
    votes: record,
  };
  if (valid.length === 0) {
    return { ...first, ...totals, status: "error", errorCode: first.errorCode ?? JUDGE_ERROR_CODE, details: baseDetails };
  }
  let passed: boolean;
  let rawValue: number;
  let score: number;
  if (grader.scale === "1_to_5") {
    rawValue = valid.reduce((total, g) => total + (g.rawValue ?? 0), 0) / valid.length;
    score = (rawValue - 1) / 4;
    passed = rawValue >= grader.passAt;
  } else {
    passed = valid.filter((g) => g.passed === true).length * 2 > valid.length;
    rawValue = passed ? 1 : 0;
    score = rawValue;
  }
  const lead = valid.find((g) => g.passed === passed) ?? valid[0]!;
  return {
    graderId: first.graderId,
    graderType: first.graderType,
    status: "graded",
    passed,
    score,
    rawValue,
    ...(lead.reason !== undefined ? { reason: lead.reason } : {}),
    ...(first.judgeModel !== undefined ? { judgeModel: first.judgeModel } : {}),
    ...totals,
    details: baseDetails,
  };
}
