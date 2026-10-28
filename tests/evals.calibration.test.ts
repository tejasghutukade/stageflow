import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeEngine } from "../src/evals/engine/index.js";
import { suggestExamples } from "../src/evals/calibrationSuggest.js";
import { EvalRunManager } from "../src/evals/manager.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { EvalPlan, RunCaseResult } from "../src/evals/types.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

let root: string;
let storeRoot: string;
let store: RunStore;
const EVAL_REL = "evals/review.eval.yaml";

const EVAL = `version: 1
id: review
type: capability
target:
  kind: stage
  pipeline: ../pipelines/feature-ship.pipeline.yaml
  stage: review
dataset: ../datasets/review.dataset.jsonl
task:
  goal: Review the change.
defaults:
  repeats: 1
  pass_threshold: 0.5
  max_cost_usd: 5
  concurrency: 1
  judge: anthropic/claude-sonnet-4-5
graders:
  - id: clear
    type: rubric
    rubric: Is the review actionable?
`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-eval-cal-"));
  storeRoot = await mkdtemp(path.join(tmpdir(), "sf-eval-cal-store-"));
  for (const dir of ["pipelines", "stages", "evals", "datasets"]) await mkdir(path.join(root, dir), { recursive: true });
  await cp(
    path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"),
    path.join(root, "pipelines", "feature-ship.pipeline.yaml"),
  );
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await writeFile(path.join(root, "stageflow.yaml"), "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n");
  await writeFile(
    path.join(root, "datasets", "review.dataset.jsonl"),
    ["c1", "c2", "c3", "c4"].map((id) => JSON.stringify({ id, input: { diff: `diff ${id}` } })).join("\n") + "\n",
  );
  await writeFile(path.join(root, EVAL_REL), EVAL);
  store = createRunStore({ rootDir: storeRoot });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(storeRoot, { recursive: true, force: true });
});

function runner(calls: string[]): StageCaseRunner {
  return {
    async runCase(_plan: EvalPlan, req): Promise<RunCaseResult> {
      calls.push(req.caseId);
      return {
        ok: true,
        stageRunId: `sr_${req.caseId}`,
        output: { kind: "envelope", status: "success", summary: `out ${req.caseId}`, payload: { id: req.caseId }, artifacts: [] },
        latencyMs: 1,
        costUsd: 0,
        tokensIn: 1,
        tokensOut: 1,
      };
    },
    async cancelAll() {},
    spend: () => 0,
    addSpend() {},
  };
}

function manager(engine: FakeEngine, calls: string[] = []): EvalRunManager {
  return new EvalRunManager({
    store,
    stageRunner: runner(calls),
    engines: () => engine,
    engineName: "fake",
    stageflowVersion: "9.9.9",
    workDirRoot: path.join(storeRoot, "eval-runs"),
  });
}

describe("EvalRunManager.calibrate", () => {
  it("re-judges labeled outputs without running the stage and stores the measurement", async () => {
    const stageCalls: string[] = [];
    const first = manager(new FakeEngine({ judge: () => ({ verdict: "pass" }) }), stageCalls);
    const { evalRunId } = await first.start({ projectRoot: root, evalPath: EVAL_REL, startedVia: "cli" });
    await first.awaitFinished(evalRunId, 10_000);
    expect(stageCalls).toHaveLength(4);

    // Human: c1, c2 pass; c3, c4 fail. Fake judge below passes c1, c3 only.
    for (const [caseId, label] of [["c1", "pass"], ["c2", "pass"], ["c3", "fail"], ["c4", "fail"]] as const) {
      await store.putEvalGraderLabel(evalRunId, caseId, 0, "clear", { label });
    }

    const replayCalls: string[] = [];
    const m = manager(
      new FakeEngine({
        judgeCostUsd: 0.01,
        judge: (_g, testCase) => ({ verdict: testCase.id === "c1" || testCase.id === "c3" ? "pass" : "fail", reason: `r-${testCase.id}` }),
      }),
      replayCalls,
    );
    const out = await m.calibrate({ projectRoot: root, evalPath: EVAL_REL, graderId: "clear" });
    expect(replayCalls).toEqual([]);
    expect(out.stats.confusion).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(out.stats.agreement).toBe(0.5);
    expect(out.stats.cohen_kappa).toBe(0);
    expect(out.disagreements.map((d) => d.caseId).sort()).toEqual(["c2", "c3"]);
    expect(out.disagreements.find((d) => d.caseId === "c3")).toMatchObject({ label: "fail", judge: "pass", reason: "r-c3" });
    expect(out.costUsd).toBeCloseTo(0.04, 6);
    expect((await store.listEvalRuns({ limit: 10 })).items).toHaveLength(1);

    const stored = await store.listEvalCalibrations(root, "review", "clear");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ candidate: false, split: "all", judge: "anthropic/claude-sonnet-4-5" });
    expect(m.activeRunId()).toBeNull();
  });

  it("measures stability by judging each output three times and reporting split votes", async () => {
    const first = manager(new FakeEngine({ judge: () => ({ verdict: "pass" }) }));
    const { evalRunId } = await first.start({ projectRoot: root, evalPath: EVAL_REL, startedVia: "cli" });
    await first.awaitFinished(evalRunId, 10_000);
    for (const id of ["c1", "c2", "c3", "c4"]) await store.putEvalGraderLabel(evalRunId, id, 0, "clear", { label: "pass" });

    const calls = new Map<string, number>();
    const m = manager(
      new FakeEngine({
        judgeCostUsd: 0.01,
        // c1 always passes; c2 splits across its three votes; c3 and c4 always fail
        judge: (_g, testCase) => {
          const n = (calls.get(testCase.id) ?? 0) + 1;
          calls.set(testCase.id, n);
          if (testCase.id === "c1") return { verdict: "pass" };
          if (testCase.id === "c2") return { verdict: n === 2 ? "fail" : "pass" };
          return { verdict: "fail" };
        },
      }),
    );
    const out = await m.calibrate({ projectRoot: root, evalPath: EVAL_REL, graderId: "clear", stability: true });
    expect([...calls.values()]).toEqual([3, 3, 3, 3]);
    expect(out.stability).toEqual({ k: 3, n: 4, unstable: 1, flip_rate: 0.25 });
    expect(out.stats.confusion).toEqual({ tp: 2, fp: 0, tn: 0, fn: 2 });
    expect(out.costUsd).toBeCloseTo(0.12, 6);
    const stored = (await store.listEvalCalibrations(root, "review", "clear"))[0]!;
    expect((stored.stats as { stability: { flip_rate: number } }).stability.flip_rate).toBe(0.25);
  });

  it("measures a candidate rubric and hides it from the default listing", async () => {
    const first = manager(new FakeEngine({ judge: () => ({ verdict: "pass" }) }));
    const { evalRunId } = await first.start({ projectRoot: root, evalPath: EVAL_REL, startedVia: "cli" });
    await first.awaitFinished(evalRunId, 10_000);
    await store.putEvalGraderLabel(evalRunId, "c1", 0, "clear", { label: "pass" });
    const seen: string[] = [];
    const m = manager(
      new FakeEngine({
        judge: (g) => {
          seen.push(g.rubric);
          return { verdict: "pass" };
        },
      }),
    );
    const out = await m.calibrate({
      projectRoot: root,
      evalPath: EVAL_REL,
      graderId: "clear",
      candidate: { rubric: "Stricter rubric" },
    });
    expect(seen).toEqual(["Stricter rubric"]);
    expect(out.calibration.candidate).toBe(true);
    expect(await store.listEvalCalibrations(root, "review", "clear")).toHaveLength(0);
    expect(await store.listEvalCalibrations(root, "review", "clear", true)).toHaveLength(1);
  });

  it("refuses with no labels and for a non-judged grader", async () => {
    const m = manager(new FakeEngine());
    await expect(m.calibrate({ projectRoot: root, evalPath: EVAL_REL, graderId: "clear" })).rejects.toMatchObject({
      code: "EVAL_CALIBRATION_NO_LABELS",
    });
    await expect(m.calibrate({ projectRoot: root, evalPath: EVAL_REL, graderId: "nope" })).rejects.toMatchObject({
      code: "EVAL_INVALID",
    });
    expect(m.activeRunId()).toBeNull();
  });

  it("keeps labels per grader and clears one with a null label", async () => {
    const first = manager(new FakeEngine({ judge: () => ({ verdict: "pass" }) }));
    const { evalRunId } = await first.start({ projectRoot: root, evalPath: EVAL_REL, startedVia: "cli" });
    await first.awaitFinished(evalRunId, 10_000);
    await store.putEvalGraderLabel(evalRunId, "c1", 0, "clear", { label: "pass", note: "ok" });
    await store.putEvalGraderLabel(evalRunId, "c1", 0, "other", { label: "fail" });
    expect(await store.listEvalGraderLabels(evalRunId)).toHaveLength(2);
    await store.putEvalGraderLabel(evalRunId, "c1", 0, "clear", { label: null });
    expect((await store.listEvalGraderLabels(evalRunId)).map((l) => l.graderId)).toEqual(["other"]);
    await expect(store.putEvalGraderLabel(evalRunId, "zz", 0, "clear", { label: "pass" })).rejects.toThrow();
    await store.deleteEvalRun(evalRunId);
    expect(await store.listEvalGraderLabels(evalRunId)).toEqual([]);
  });
});

describe("suggestExamples", () => {
  it("builds distinct examples from disagreements, leniency first, with the label note as the reason", async () => {
    const first = manager(new FakeEngine({ judge: () => ({ verdict: "pass" }) }));
    const { evalRunId } = await first.start({ projectRoot: root, evalPath: EVAL_REL, startedVia: "cli" });
    await first.awaitFinished(evalRunId, 10_000);
    await store.putEvalGraderLabel(evalRunId, "c1", 0, "clear", { label: "fail", note: "not actionable" });
    await store.putEvalGraderLabel(evalRunId, "c2", 0, "clear", { label: "pass" });
    await store.putEvalGraderLabel(evalRunId, "c3", 0, "clear", { label: "fail" });

    // judge: c1 pass (too lenient vs fail), c2 fail (too strict vs pass), c3 pass (too lenient)
    const m = manager(
      new FakeEngine({ judge: (_g, testCase) => ({ verdict: testCase.id === "c2" ? "fail" : "pass", reason: "r" }) }),
    );
    const out = await m.calibrate({ projectRoot: root, evalPath: EVAL_REL, graderId: "clear" });
    expect(out.disagreements.every((d) => d.evalRunId === evalRunId)).toBe(true);

    const items = await suggestExamples(store, {
      projectRoot: root,
      evalId: "review",
      graderId: "clear",
      scale: "pass_fail",
      calibration: out.calibration,
      limit: 3,
    });
    // labels are read newest first, so which lenient case comes first depends on timing; the kinds alternate
    expect(items.map((i) => i.judge)).toEqual(["pass", "fail", "pass"]);
    expect(items.map((i) => i.case_id).sort()).toEqual(["c1", "c2", "c3"]);
    const byCase = new Map(items.map((i) => [i.case_id, i.example]));
    expect(byCase.get("c1")).toEqual({ verdict: "fail", output: expect.stringContaining("out c1"), reason: "not actionable" });
    expect(byCase.get("c2")).toMatchObject({ verdict: "pass" });
    expect("reason" in byCase.get("c2")!).toBe(false);

    const scored = await suggestExamples(store, {
      projectRoot: root,
      evalId: "review",
      graderId: "clear",
      scale: "1_to_5",
      calibration: out.calibration,
      limit: 1,
    });
    expect(scored).toHaveLength(1);
    expect(scored[0]!.example).toMatchObject({ score: 1 });
  });

  it("skips disagreements stored without a run id", async () => {
    const items = await suggestExamples(store, {
      projectRoot: root,
      evalId: "review",
      graderId: "clear",
      scale: "pass_fail",
      calibration: { disagreements: [{ caseId: "c1", repeatIndex: 0, label: "fail", judge: "pass", reason: null }] },
    });
    expect(items).toEqual([]);
  });
});
