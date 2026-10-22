import type { EvalListItem } from "../../../api";
import { evalNewPath, evalPath, evalsPath } from "../../../routes";
import { formatPercent, formatRelativeTime } from "../../evals/format";

export const AGENT_EVALS_GUIDANCE = "Run an eval before you save changes to this agent.";
export const AGENT_EVALS_EMPTY = "No evals yet. Create one to check this agent before you ship changes.";

export type AgentEvalRow = {
  id: string;
  href: string;
  meta: string;
  passRateLabel: string | null;
  passRate: number | null;
};

export type AgentEvalsModel = {
  total: number;
  rows: AgentEvalRow[];
  newEvalHref: string;
  evaluateHref: string;
  guidance: string | null;
};

export function agentEvalRow(item: EvalListItem, now: number): AgentEvalRow {
  const cases = `${item.dataset_cases} ${item.dataset_cases === 1 ? "case" : "cases"}`;
  const finished = item.last_run?.finished_at;
  const passRate = item.last_run?.pass_rate ?? null;
  return {
    id: item.id,
    href: evalPath(item.id),
    meta: finished ? `${cases} · last run ${formatRelativeTime(finished, now)}` : `${cases} · never run`,
    passRate,
    passRateLabel: passRate === null ? null : formatPercent(passRate),
  };
}

export function agentEvaluateHref(agentId: string, evalIds: string[]): string {
  if (evalIds.length === 1) return evalPath(evalIds[0]!, { openRun: true });
  if (evalIds.length >= 2) return evalsPath({ agent: agentId });
  return evalNewPath({ agent: agentId });
}

export function buildAgentEvalsModel(agentId: string, items: EvalListItem[], now: number): AgentEvalsModel {
  const mine = items.filter((i) => i.target.kind === "agent" && i.target.agent_id === agentId);
  return {
    total: mine.length,
    rows: mine.map((i) => agentEvalRow(i, now)),
    newEvalHref: evalNewPath({ agent: agentId }),
    evaluateHref: agentEvaluateHref(
      agentId,
      mine.map((i) => i.id),
    ),
    guidance: mine.length > 0 ? AGENT_EVALS_GUIDANCE : null,
  };
}
