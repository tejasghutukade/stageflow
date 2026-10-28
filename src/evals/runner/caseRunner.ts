import { isConversationTarget, type EvalPlan, type RunCaseRequest, type RunCaseResult } from "../types.js";
import type { StageCaseRunner } from "./stageCaseRunner.js";

export type EvalCaseRunner = StageCaseRunner;

type Kind = "stage" | "agent" | "internal_agent";

/** Routes each case to the stage, agent, or internal-agent runner by the plan's target kind. */
export function createEvalCaseRunner(deps: {
  stage: StageCaseRunner;
  agent: StageCaseRunner;
  internalAgent?: StageCaseRunner;
}): EvalCaseRunner {
  const kinds = new Map<string, Kind>();
  const runnerOf = (evalRunId: string): StageCaseRunner => {
    const kind = kinds.get(evalRunId);
    if (kind === "internal_agent" && deps.internalAgent) return deps.internalAgent;
    return kind === "agent" ? deps.agent : deps.stage;
  };
  return {
    runCase(plan: EvalPlan, req: RunCaseRequest): Promise<RunCaseResult> {
      const kind: Kind = plan.target.kind === "internal_agent" ? "internal_agent" : isConversationTarget(plan.target.kind) ? "agent" : "stage";
      kinds.set(req.evalRunId, kind);
      return runnerOf(req.evalRunId).runCase(plan, req);
    },
    async cancelAll(evalRunId) {
      await Promise.all([
        deps.stage.cancelAll(evalRunId),
        deps.agent.cancelAll(evalRunId),
        deps.internalAgent?.cancelAll(evalRunId),
      ]);
    },
    spend: (evalRunId) =>
      deps.stage.spend(evalRunId) + deps.agent.spend(evalRunId) + (deps.internalAgent?.spend(evalRunId) ?? 0),
    addSpend: (evalRunId, usd) => runnerOf(evalRunId).addSpend(evalRunId, usd),
    stopReason: (evalRunId) => runnerOf(evalRunId).stopReason?.(evalRunId),
  };
}
