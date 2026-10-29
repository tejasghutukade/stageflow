import type { EvalLabelCounts, EvalLabelQueueItem } from "../../../api/evalTypes";

/** The server asks for this many labels before a reading is reliable, and at least a fifth of each kind. */
export const LABEL_TARGET = 20;
export const MINORITY_SHARE = 0.2;

export type QueueOrder = "mixed" | "unlabeled" | "all";

export const ORDER_LABELS: Record<QueueOrder, string> = {
  mixed: "Unlabeled, mixed",
  unlabeled: "Unlabeled, in order",
  all: "Everything",
};

export type QueueEntry = { key: string; item: EvalLabelQueueItem };

export const keyOf = (caseId: string, repeatIndex: number): string => `${caseId}#${repeatIndex}`;

export const entryOf = (item: EvalLabelQueueItem): QueueEntry => ({
  key: keyOf(item.case.id, item.result.repeat_index),
  item,
});

/**
 * The order to walk through, fixed when the screen opens so going back never lands somewhere else.
 * "mixed" alternates results the judge passed and failed (the rarer kind first), so both kinds of label
 * turn up early and the labels are not all one verdict.
 */
export function orderQueue(items: EvalLabelQueueItem[], order: QueueOrder): QueueEntry[] {
  const entries = items.map(entryOf);
  if (order === "all") return entries;
  const open = entries.filter((e) => e.item.label === null);
  if (order === "unlabeled") return open;
  const passed = open.filter((e) => e.item.judge.passed);
  const failed = open.filter((e) => !e.item.judge.passed);
  const [first, second] = failed.length <= passed.length ? [failed, passed] : [passed, failed];
  const mixed: QueueEntry[] = [];
  for (let i = 0; mixed.length < open.length; i++) {
    if (first[i]) mixed.push(first[i]!);
    if (second[i]) mixed.push(second[i]!);
  }
  return mixed;
}

export function countLabels(items: Array<{ label: { label: "pass" | "fail" } | null }>): EvalLabelCounts {
  return {
    pass: items.filter((i) => i.label?.label === "pass").length,
    fail: items.filter((i) => i.label?.label === "fail").length,
  };
}

export type LabelAdvice = {
  total: number;
  ready: boolean;
  /** 0..1 toward the target, for a progress bar. */
  fraction: number;
  /** One short sentence on what to do next. */
  text: string;
};

export function labelAdvice(counts: EvalLabelCounts): LabelAdvice {
  const total = counts.pass + counts.fail;
  const fraction = Math.min(1, total / LABEL_TARGET);
  const minority = Math.min(counts.pass, counts.fail);
  const needMinority = Math.ceil(LABEL_TARGET * MINORITY_SHARE);
  const rare = counts.pass < counts.fail ? "Pass" : "Fail";
  if (total >= LABEL_TARGET && minority >= needMinority) {
    return { total, ready: true, fraction, text: "Enough labels. You can check the judge now." };
  }
  if (total >= LABEL_TARGET) {
    const more = needMinority - minority;
    return { total, ready: false, fraction, text: `Label ${more} more ${rare} result${more === 1 ? "" : "s"} so both kinds are covered.` };
  }
  const left = LABEL_TARGET - total;
  if (total >= 4 && minority < Math.ceil(total * MINORITY_SHARE)) {
    return { total, ready: false, fraction, text: `${left} to go. Look for some ${rare} results too.` };
  }
  return { total, ready: false, fraction, text: `${left} to go.` };
}

/** What happened when the author's verdict met the judge's, in words for a brief confirmation. */
export function agreementText(item: EvalLabelQueueItem, label: "pass" | "fail"): { agrees: boolean; text: string } {
  const agrees = item.judge.passed === (label === "pass");
  return agrees
    ? { agrees, text: `The judge agreed (${item.judge.passed ? "Pass" : "Fail"}).` }
    : { agrees, text: `The judge said ${item.judge.passed ? "Pass" : "Fail"}, you said ${label === "pass" ? "Pass" : "Fail"}.` };
}

export type QueueKey = "pass" | "fail" | "skip" | "back" | "next" | "judge" | "close";

export function keyAction(key: string): QueueKey | null {
  switch (key.toLowerCase()) {
    case "p":
      return "pass";
    case "f":
      return "fail";
    case "s":
      return "skip";
    case "j":
      return "judge";
    case "arrowleft":
      return "back";
    case "arrowright":
      return "next";
    case "escape":
      return "close";
    default:
      return null;
  }
}

export const JUDGE_HIDDEN_KEY = "sf.evals.label.hideJudge";

/** Hiding the judge's answer until you decide is the default: it keeps your label your own. */
export function readHideJudge(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(JUDGE_HIDDEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeHideJudge(storage: Pick<Storage, "setItem"> | null, hide: boolean): void {
  try {
    storage?.setItem(JUDGE_HIDDEN_KEY, hide ? "1" : "0");
  } catch {
    /* a private window can refuse storage; the default applies next time */
  }
}

/** The line that says what a good answer to this case looks like, when the dataset wrote one. */
export function wantedText(item: EvalLabelQueueItem): string | null {
  const expected = item.case.expected;
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const outcome = (expected as Record<string, unknown>).outcome;
    if (typeof outcome === "string" && outcome.trim() !== "") return outcome.trim();
  }
  if (typeof item.case.goal === "string" && item.case.goal.trim() !== "") return item.case.goal.trim();
  return null;
}

export type QueueScreen = "loading" | "empty" | "finished" | "item";

/** Which of the queue's screens to draw. `index` may equal `count` once the last result is passed. */
export function queueScreen(loaded: boolean, count: number, index: number): QueueScreen {
  if (!loaded) return "loading";
  if (count === 0) return "empty";
  return index >= count ? "finished" : "item";
}

/** Label totals across the whole eval: other runs' labels from the server plus this run's, as edited here. */
export function queueTotals(
  labeledEval: EvalLabelCounts | null,
  labeledHere: EvalLabelCounts | null,
  items: Array<{ label: { label: "pass" | "fail" } | null }>,
): EvalLabelCounts {
  const mine = countLabels(items);
  const others = {
    pass: Math.max(0, (labeledEval?.pass ?? 0) - (labeledHere?.pass ?? 0)),
    fail: Math.max(0, (labeledEval?.fail ?? 0) - (labeledHere?.fail ?? 0)),
  };
  return { pass: others.pass + mine.pass, fail: others.fail + mine.fail };
}

/** The judge's answer stays hidden while the author decides, unless they asked to see it or already labeled. */
export function judgeVisible(hideJudge: boolean, revealed: boolean, labeled: boolean): boolean {
  return !hideJudge || revealed || labeled;
}

export function clampIndex(to: number, count: number): number {
  return Math.max(0, Math.min(count, to));
}
