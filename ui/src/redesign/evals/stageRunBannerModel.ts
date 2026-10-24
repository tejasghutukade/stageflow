import type { EvalRunListItem } from "../../api";
import { evalCasePath, evalRunPath } from "../../routes";

export type StageRunBannerModel = { text: string; href: string };

export function stageRunBannerModel(items: EvalRunListItem[]): StageRunBannerModel | null {
  const item = items[0];
  if (!item) return null;
  const href = item.result
    ? evalCasePath(item.eval_id, item.run_number, item.result.case_id, { repeat: item.result.repeat_index })
    : evalRunPath(item.eval_id, item.run_number);
  return { text: `This run was started by eval ${item.eval_id}, run #${item.run_number}`, href };
}
