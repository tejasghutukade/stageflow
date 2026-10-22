import type { EvalPlan, RunCaseRequest, RunCaseResult } from "../types.js";
import type { StageCaseRunner } from "./stageCaseRunner.js";

export type EvalCaseRunner = StageCaseRunner;

/** Routes each case to the stage or agent runner by the plan's target kind. */
export function createEvalCaseRunner(deps: { stage: StageCaseRunner; agent: StageCaseRunner }): EvalCaseRunner {
  const kinds = new Map<string, "stage" | "agent">();
  const runnerOf = (evalRunId: string): StageCaseRunner => (kinds.get(evalRunId) === "agent" ? deps.agent : deps.stage);
  return {
    runCase(plan: EvalPlan, req: RunCaseRequest): Promise<RunCaseResult> {
      kinds.set(req.evalRunId, plan.target.kind === "agent" ? "agent" : "stage");
      return runnerOf(req.evalRunId).runCase(plan, req);
    },
    async cancelAll(evalRunId) {
      await Promise.all([deps.stage.cancelAll(evalRunId), deps.agent.cancelAll(evalRunId)]);
    },
    spend: (evalRunId) => deps.stage.spend(evalRunId) + deps.agent.spend(evalRunId),
    addSpend: (evalRunId, usd) => runnerOf(evalRunId).addSpend(evalRunId, usd),
  };
}
