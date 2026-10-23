import { describe, expect, it } from "vitest";
import type { EvalRunListItem } from "../../../api/evalTypes";
import {
  baselinePickerOptions,
  baselineRuns,
  buildContext,
  compareBaseline,
  defaultBaseline,
  edgeEnabled,
  filterPickerOptions,
  initialState,
  modelPickerOptions,
  nextEnabled,
  showBaselineChooser,
} from "./runDialogModel";

function item(n: number, status: EvalRunListItem["status"], extra: Partial<EvalRunListItem> = {}): EvalRunListItem {
  return {
    eval_run_id: `r${n}`,
    eval_id: "e",
    run_number: n,
    status,
    passed: status === "completed" ? true : null,
    pass_rate: status === "completed" ? 0.5 : null,
    pass_rate_ci: null,
    results_executed: 0,
    cost_total: 0,
    finished_at: null,
    fingerprint: "f",
    label: null,
    ...extra,
  } as EvalRunListItem;
}

const detail = {
  id: "e",
  path: "e.eval.yaml",
  file_hash: "h",
  definition: { version: 1, id: "e", target: { kind: "stage", pipeline: "p", stage: "s" }, dataset: "d.dataset.jsonl", graders: [] },
  yaml: "",
  findings: [],
  runs_count: 3,
  last_run: null,
} as any;

function ctxWith(items: EvalRunListItem[]) {
  const earlierRuns = baselineRuns(items);
  const newest = earlierRuns.find((r) => r.selectable);
  return buildContext({
    evalId: "e",
    detail,
    casesTotal: 1,
    earlierRuns,
    lastCompleted: newest ? { evalRunId: `r${newest.runNumber}`, runNumber: newest.runNumber, failedCases: 0 } : null,
  });
}

describe("model picker options", () => {
  const models = [
    { id: "openrouter/x/m1", provider: "openrouter", name: "M One" },
    { id: "anthropic/claude", provider: "anthropic", name: "Claude", judge_capable: false },
    { id: "anthropic/opus", provider: "anthropic", name: "Opus" },
  ];
  it("keeps the default first and groups by provider", () => {
    const o = modelPickerOptions(models, "Eval default · a/b", false);
    expect(o[0]).toMatchObject({ value: "", label: "Eval default · a/b", isDefault: true });
    expect(o.slice(1).map((x) => x.group)).toEqual(["anthropic", "anthropic", "openrouter"]);
    expect(o.find((x) => x.value === "openrouter/x/m1")).toMatchObject({ label: "M One", sublabel: "x/m1" });
  });
  it("limits to judge-capable models for judges", () => {
    expect(modelPickerOptions(models, "d", true).map((x) => x.value)).toEqual(["", "anthropic/opus", "openrouter/x/m1"]);
  });
  it("filters by name, id or provider and hides the default while typing", () => {
    const o = modelPickerOptions(models, "d", false);
    expect(filterPickerOptions(o, "").length).toBe(4);
    expect(filterPickerOptions(o, "OPUS").map((x) => x.value)).toEqual(["anthropic/opus"]);
    expect(filterPickerOptions(o, "openrouter").map((x) => x.value)).toEqual(["openrouter/x/m1"]);
  });
});

describe("keyboard helpers", () => {
  const opts = [
    { value: "a", label: "a", disabled: true },
    { value: "b", label: "b" },
    { value: "c", label: "c", disabled: true },
    { value: "d", label: "d" },
  ];
  it("skips disabled options", () => {
    expect(edgeEnabled(opts, "first")).toBe(1);
    expect(edgeEnabled(opts, "last")).toBe(3);
    expect(nextEnabled(opts, 1, 1)).toBe(3);
    expect(nextEnabled(opts, 3, 1)).toBe(3);
    expect(nextEnabled(opts, 3, -1)).toBe(1);
    expect(nextEnabled(opts, 1, -1)).toBe(1);
  });
});

describe("baseline runs", () => {
  const items = [item(1, "completed"), item(2, "failed"), item(3, "completed", { label: "good" }), item(4, "cancelled")];
  it("lists newest first and only completed runs are selectable", () => {
    const runs = baselineRuns(items);
    expect(runs.map((r) => r.runNumber)).toEqual([4, 3, 2, 1]);
    expect(runs.map((r) => r.selectable)).toEqual([false, true, false, true]);
    expect(runs[0]!.reason).toMatch(/Only completed runs/);
    expect(defaultBaseline(runs)).toBe(3);
    const options = baselinePickerOptions(runs);
    expect(options[0]).toMatchObject({ value: "4", label: "Run #4", disabled: true });
    expect(options[1]).toMatchObject({ value: "3", meta: "50.0%", disabled: false });
  });
  it("defaults to the newest completed run and honors a valid choice", () => {
    const c = ctxWith(items);
    expect(initialState(c).compareWith).toBe(3);
    expect(compareBaseline({ compareWith: 1 }, c)).toBe(1);
    expect(compareBaseline({ compareWith: 2 }, c)).toBe(3);
    expect(compareBaseline({ compareWith: 99 }, c)).toBe(3);
  });
  it("shows the chooser only with several earlier runs", () => {
    expect(showBaselineChooser(ctxWith(items))).toBe(true);
    expect(showBaselineChooser(ctxWith([item(1, "completed")]))).toBe(false);
    expect(showBaselineChooser(ctxWith([item(1, "failed"), item(2, "completed")]))).toBe(true);
    const none = ctxWith([]);
    expect(showBaselineChooser(none)).toBe(false);
    expect(initialState(none).compare).toBe(false);
    expect(compareBaseline({ compareWith: null }, none)).toBeNull();
  });
});
