import type { EvalRunListItem } from "../../api";
import { evalCasePath, evalRunPath } from "../../routes";

export type AgentSessionBannerModel = { text: string; href: string };

export function agentSessionBannerModel(items: EvalRunListItem[]): AgentSessionBannerModel | null {
  const item = items[0];
  if (!item) return null;
  const href = item.result
    ? evalCasePath(item.eval_id, item.run_number, item.result.case_id, { repeat: item.result.repeat_index, tab: "transcript" })
    : evalRunPath(item.eval_id, item.run_number);
  return { text: `This session was created by eval ${item.eval_id}, run #${item.run_number}`, href };
}
