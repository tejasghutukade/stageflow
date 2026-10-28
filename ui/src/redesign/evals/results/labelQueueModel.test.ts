import { describe, expect, it } from "vitest";
import type { EvalLabelQueueItem, EvalResultDetail } from "../../../api/evalTypes";
import {
  agreementText,
  countLabels,
  keyAction,
  labelAdvice,
  orderQueue,
  readHideJudge,
  wantedText,
  writeHideJudge,
  JUDGE_HIDDEN_KEY,
} from "./labelQueueModel";

function item(id: string, judgePassed: boolean, label: "pass" | "fail" | null = null, repeat = 0): EvalLabelQueueItem {
  return {
    case: { id, input: {} },
    result: { case_id: id, repeat_index: repeat } as EvalResultDetail,
    judge: { passed: judgePassed, score: judgePassed ? 1 : 0, reason: "r" },
    label: label === null ? null : { label, note: null },
  };
}

const ids = (items: ReturnType<typeof orderQueue>) => items.map((e) => e.key);

describe("orderQueue", () => {
  const items = [item("a", true), item("b", true), item("c", true), item("d", false), item("e", true, "pass")];

  it("keeps everything in order for 'all'", () => {
    expect(ids(orderQueue(items, "all"))).toEqual(["a#0", "b#0", "c#0", "d#0", "e#0"]);
  });

  it("keeps only unlabeled results, in order, for 'unlabeled'", () => {
    expect(ids(orderQueue(items, "unlabeled"))).toEqual(["a#0", "b#0", "c#0", "d#0"]);
  });

  it("alternates judge verdicts, rarer kind first, for 'mixed'", () => {
    expect(ids(orderQueue(items, "mixed"))).toEqual(["d#0", "a#0", "b#0", "c#0"]);
  });

  it("alternates evenly when both kinds are plentiful", () => {
    const many = [item("p1", true), item("p2", true), item("f1", false), item("f2", false)];
    expect(ids(orderQueue(many, "mixed"))).toEqual(["f1#0", "p1#0", "f2#0", "p2#0"]);
  });

  it("is empty when everything is labeled", () => {
    expect(orderQueue([item("a", true, "pass")], "mixed")).toEqual([]);
  });
});

describe("labelAdvice", () => {
  it("counts down to the target", () => {
    expect(labelAdvice({ pass: 3, fail: 2 })).toMatchObject({ total: 5, ready: false, text: "15 to go." });
  });

  it("nudges toward the missing kind", () => {
    expect(labelAdvice({ pass: 9, fail: 0 }).text).toBe("11 to go. Look for some Fail results too.");
  });

  it("asks for the rarer kind once the total is reached", () => {
    expect(labelAdvice({ pass: 20, fail: 1 })).toMatchObject({ ready: false, text: "Label 3 more Fail results so both kinds are covered." });
    expect(labelAdvice({ pass: 19, fail: 1 }).text).toBe("Label 3 more Fail results so both kinds are covered.");
  });

  it("is ready with enough of both", () => {
    const advice = labelAdvice({ pass: 14, fail: 6 });
    expect(advice).toMatchObject({ ready: true, fraction: 1 });
  });

  it("caps the progress fraction", () => {
    expect(labelAdvice({ pass: 40, fail: 40 }).fraction).toBe(1);
    expect(labelAdvice({ pass: 5, fail: 5 }).fraction).toBe(0.5);
  });
});

describe("countLabels and agreementText", () => {
  it("counts each verdict", () => {
    expect(countLabels([item("a", true, "pass"), item("b", true, "fail"), item("c", true, "fail"), item("d", true)])).toEqual({ pass: 1, fail: 2 });
  });

  it("says whether the judge agreed", () => {
    expect(agreementText(item("a", true), "pass")).toEqual({ agrees: true, text: "The judge agreed (Pass)." });
    expect(agreementText(item("a", false), "pass")).toEqual({ agrees: false, text: "The judge said Fail, you said Pass." });
  });
});

describe("keyAction and the hide-judge preference", () => {
  it("maps keys to actions", () => {
    expect(keyAction("p")).toBe("pass");
    expect(keyAction("F")).toBe("fail");
    expect(keyAction("ArrowLeft")).toBe("back");
    expect(keyAction("x")).toBeNull();
  });

  it("hides the judge by default and remembers a change", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readHideJudge(storage)).toBe(true);
    writeHideJudge(storage, false);
    expect(store.get(JUDGE_HIDDEN_KEY)).toBe("0");
    expect(readHideJudge(storage)).toBe(false);
    expect(readHideJudge(null)).toBe(true);
  });
});

describe("wantedText", () => {
  const withCase = (c: Partial<EvalLabelQueueItem["case"]>): EvalLabelQueueItem => ({ ...item("a", true), case: { id: "a", input: {}, ...c } });

  it("prefers the expected outcome, then the goal", () => {
    expect(wantedText(withCase({ expected: { outcome: "  Say no.  " }, goal: "g" }))).toBe("Say no.");
    expect(wantedText(withCase({ goal: "Reach the goal" }))).toBe("Reach the goal");
    expect(wantedText(withCase({ expected: { tools: [] } }))).toBeNull();
    expect(wantedText(withCase({}))).toBeNull();
  });
});
