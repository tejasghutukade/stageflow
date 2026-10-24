import type { BudgetWarning, GradeStatus, ResultStatus, RunBudget } from "./statsTypes.js";

const EPS = 1e-9;

export interface ScoringGrader {
  id: string;
  type?: string;
  weight: number;
  mustPass: boolean;
  scale?: "pass_fail" | "1_to_5";
  passAt?: number;
}

export interface ScoringGrade {
  graderId: string;
  status: GradeStatus;
  passed: 0 | 1 | boolean | null;
  score: number | null;
  rawValue?: number | null;
}

export interface ScoreResultInput {
  graders: ScoringGrader[];
  grades: ScoringGrade[];
  passThreshold: number;
  status: ResultStatus;
  latencyMs: number | null;
  costUsd: number | null;
  budget?: RunBudget | null;
}

export interface ScoreResultOutput {
  score: number | null;
  passed: boolean;
  hasGraderErrors: boolean;
  budgetWarnings: BudgetWarning[];
}

export function normalizeOneToFive(raw: number): number {
  return (raw - 1) / 4;
}

export function graderPassed(
  grader: ScoringGrader,
  grade: Pick<ScoringGrade, "passed" | "score" | "rawValue">,
  passThreshold: number,
): boolean {
  if (grade.passed !== null && grade.passed !== undefined) return Boolean(grade.passed);
  const score = grade.score ?? 0;
  if (grader.type === "reference") return score + EPS >= (grader.passAt ?? 1);
  if (grader.type === "rubric" && grader.scale === "1_to_5") {
    return (grade.rawValue ?? 0) + EPS >= (grader.passAt ?? 4);
  }
  if (grader.type === "code") return score + EPS >= passThreshold;
  return score + EPS >= 1;
}

function budgetWarnings(
  latencyMs: number | null,
  costUsd: number | null,
  budget: RunBudget | null | undefined,
): BudgetWarning[] {
  const warnings: BudgetWarning[] = [];
  if (budget?.latencyMs != null && latencyMs != null && latencyMs > budget.latencyMs) {
    warnings.push("latency");
  }
  if (budget?.costUsd != null && costUsd != null && costUsd > budget.costUsd) {
    warnings.push("cost");
  }
  return warnings;
}

export function scoreResult(input: ScoreResultInput): ScoreResultOutput {
  const warnings = budgetWarnings(input.latencyMs, input.costUsd, input.budget);
  if (input.status !== "completed") {
    return { score: null, passed: false, hasGraderErrors: false, budgetWarnings: warnings };
  }

  const gradeById = new Map<string, ScoringGrade>();
  for (const grade of input.grades) gradeById.set(grade.graderId, grade);

  let mustPassFailed = false;
  let hasGraderErrors = false;
  let weightedSum = 0;
  let weightTotal = 0;

  for (const grader of input.graders) {
    const grade = gradeById.get(grader.id);
    if (grader.mustPass) {
      if (!grade) {
        mustPassFailed = true;
      } else if (grade.status === "error") {
        mustPassFailed = true;
        hasGraderErrors = true;
      } else if (!graderPassed(grader, grade, input.passThreshold)) {
        mustPassFailed = true;
      }
      continue;
    }
    if (!grade) continue;
    if (grade.status === "error") {
      hasGraderErrors = true;
      continue;
    }
    weightedSum += grader.weight * (grade.score ?? 0);
    weightTotal += grader.weight;
  }

  const score = weightTotal > 0 ? weightedSum / weightTotal : mustPassFailed ? 0 : 1;
  const passed = !mustPassFailed && score + EPS >= input.passThreshold;
  return { score, passed, hasGraderErrors, budgetWarnings: warnings };
}
