import type { TaskFile } from "../types/task.js";
import type { EvalPlan, PlanCase } from "./types.js";

export function caseToTask(
  plan: Pick<EvalPlan, "task">,
  testCase: Pick<PlanCase, "id" | "goal" | "input">,
  evalRunId: string,
  repeatIndex: number,
): TaskFile {
  return {
    id: `eval-${evalRunId}-${testCase.id}-${repeatIndex}`,
    goal: testCase.goal ?? plan.task.goal ?? `Evaluate case ${testCase.id}`,
    ...(plan.task.context !== undefined ? { context: plan.task.context } : {}),
    ...(plan.task.constraints !== undefined ? { constraints: plan.task.constraints } : {}),
    input: testCase.input,
  };
}
