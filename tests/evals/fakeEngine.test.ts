import { describe, expect, it } from "vitest";
import { FakeEngine, type FakeEngineOptions } from "../../src/evals/engine/FakeEngine.js";
import { getEngine } from "../../src/evals/engine/index.js";
import type {
  EngineIo,
  EvalPlan,
  NormalizedResult,
  ResolvedGrader,
  RunCaseRequest,
  RunCaseResult,
} from "../../src/evals/types.js";

const common = { weight: 1, mustPass: false, hash: "abc123" };
const graders: ResolvedGrader[] = [
  { ...common, id: "f", type: "field", checks: [{ path: "payload.ok", op: "equals", value: true }] },
  {
    ...common,
    id: "r",
    type: "rubric",
    rubric: "good?",
    scale: "1_to_5",
    passAt: 4,
    judge: "anthropic/x",
    examples: [],
  },
];

function plan(over: Partial<EvalPlan> = {}): EvalPlan {
  return {
    evalRunId: "er_1",
    projectRoot: "/p",
    evalId: "e",
    target: { kind: "stage", stageId: "s" },
    targetVersionHash: "h",
    stageModel: "m",
    task: {},
    cases: ["a", "b", "c"].map((id, position) => ({ id, position, input: {}, tags: [] })),
    graders,
    repeats: 2,
    passThreshold: 0.8,
    concurrency: 2,
    maxCostUsd: 2,
    ...over,
  };
}

function okRun(ok = true): RunCaseResult {
  return {
    ok: true,
    stageRunId: "r1",
    output: { kind: "envelope", status: "success", summary: "s", payload: { ok }, artifacts: [] },
    latencyMs: 5,
    costUsd: 0.01,
    tokensIn: 1,
    tokensOut: 2,
  };
}

function harness(runCase?: (req: RunCaseRequest) => Promise<RunCaseResult>) {
  const events: string[] = [];
  const results: NormalizedResult[] = [];
  const judgeCosts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const started: string[] = [];
  const io: EngineIo = {
    async runCase(req) {
      started.push(`${req.caseId}/${req.repeatIndex}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return runCase ? await runCase(req) : (await new Promise((r) => setTimeout(r, 5)), okRun());
      } finally {
        inFlight--;
      }
    },
    onResult(r) {
      events.push(`result:${r.caseId}/${r.repeatIndex}`);
      results.push(r);
    },
    reportJudgeCost: (u) => judgeCosts.push(u),
    onPhase: (c, r, p) => events.push(`${p}:${c}/${r}`),
    log: () => {},
  };
  return { io, events, results, judgeCosts, started, max: () => maxInFlight };
}

const run = (opts: FakeEngineOptions | undefined, p: EvalPlan, h: ReturnType<typeof harness>, s = new AbortController().signal) =>
  new FakeEngine(opts).run(p, h.io, s);

describe("FakeEngine", () => {
  it("emits plan.cases x repeats results with grades", async () => {
    const h = harness();
    await run(undefined, plan(), h);
    expect(h.results).toHaveLength(6);
    const keys = new Set(h.results.map((r) => `${r.caseId}/${r.repeatIndex}`));
    expect(keys.size).toBe(6);
    for (const r of h.results) {
      expect(r.grades.map((g) => g.graderId)).toEqual(["f", "r"]);
      expect(r.grades[0]).toMatchObject({ status: "graded", passed: true, score: 1 });
      expect(r.grades[1]).toMatchObject({ rawValue: 5, score: 1, passed: true });
    }
  });

  it("calls phases in order per result", async () => {
    const h = harness();
    await run(undefined, plan({ concurrency: 1 }), h);
    const first = h.events.filter((e) => e.endsWith("a/0"));
    expect(first).toEqual(["stage_running:a/0", "grading:a/0", "result:a/0", "done:a/0"]);
    expect(h.events.filter((e) => e.startsWith("done:"))).toHaveLength(6);
  });

  it("honors concurrency", async () => {
    const h = harness();
    await run(undefined, plan({ concurrency: 2 }), h);
    expect(h.max()).toBe(2);
    const h1 = harness();
    await run(undefined, plan({ concurrency: 1 }), h1);
    expect(h1.max()).toBe(1);
  });

  it("scripted judge score 4 gives rawValue 4, score 0.75", async () => {
    const h = harness();
    await run({ judge: () => ({ score: 4, reason: "ok" }), judgeCostUsd: 0.02 }, plan({ repeats: 1 }), h);
    const g = h.results[0].grades[1];
    expect(g).toMatchObject({ rawValue: 4, score: 0.75, passed: true, reason: "ok", judgeModel: "anthropic/x", judgeCostUsd: 0.02 });
    expect(h.judgeCosts).toEqual([0.02, 0.02, 0.02]);
  });

  it("pass_fail judge verdicts, and judge reply mismatch is an error grade", async () => {
    const pf: ResolvedGrader = { ...common, id: "j", type: "rubric", rubric: "x", scale: "pass_fail", passAt: 4, judge: "j", examples: [] };
    const h = harness();
    await run({ judge: (_g, c) => (c.id === "a" ? { verdict: "fail" } : { score: 3 }) }, plan({ graders: [pf], repeats: 1 }), h);
    const a = h.results.find((r) => r.caseId === "a")!.grades[0];
    expect(a).toMatchObject({ status: "graded", passed: false, score: 0, rawValue: 0 });
    const b = h.results.find((r) => r.caseId === "b")!.grades[0];
    expect(b).toMatchObject({ status: "error", errorCode: "EVAL_JUDGE_ERROR" });
  });

  it("a failed runCase emits with no grades", async () => {
    const h = harness(async () => ({ ok: false, code: "EVAL_STAGE_FAILED", message: "x" }));
    await run(undefined, plan(), h);
    expect(h.results).toHaveLength(6);
    expect(h.results.every((r) => r.grades.length === 0)).toBe(true);
    expect(h.events.some((e) => e.startsWith("grading:"))).toBe(false);
  });

  it("budget exceeded emits that result and stops new work", async () => {
    let n = 0;
    const h = harness(async () => (++n === 2 ? { ok: false, code: "EVAL_BUDGET_EXCEEDED", message: "b" } : okRun()));
    await run(undefined, plan({ concurrency: 1 }), h);
    expect(h.results).toHaveLength(2);
    expect(h.results[1].run).toMatchObject({ ok: false, code: "EVAL_BUDGET_EXCEEDED" });
  });

  it("stops on abort with no new work started", async () => {
    const ac = new AbortController();
    const h = harness();
    const p = run({ delayMs: { stage_running: 20 } }, plan({ concurrency: 2 }), h, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await p;
    expect(h.started).toHaveLength(2);
    expect(h.results).toHaveLength(2);
  });

  it("already-aborted signal does nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness();
    await run(undefined, plan(), h, ac.signal);
    expect(h.started).toHaveLength(0);
  });

  it("sequential order is case order; shuffled is seeded", async () => {
    const seq = harness();
    await run({ order: "sequential" }, plan({ concurrency: 1 }), seq);
    expect(seq.started).toEqual(["a/0", "a/1", "b/0", "b/1", "c/0", "c/1"]);
    const s1 = harness();
    const s2 = harness();
    await run({ order: "shuffled", seed: 7 }, plan({ concurrency: 1 }), s1);
    await run({ order: "shuffled", seed: 7 }, plan({ concurrency: 1 }), s2);
    expect(s1.started).toEqual(s2.started);
    expect([...s1.started].sort()).toEqual([...seq.started].sort());
    const s3 = harness();
    await run({ order: "shuffled", seed: 8 }, plan({ concurrency: 1 }), s3);
    expect(s3.started).not.toEqual(s1.started);
  });

  it("failEngineAfter throws EVAL_ENGINE_ERROR after N results", async () => {
    const h = harness();
    const err = await run({ failEngineAfter: 2 }, plan({ concurrency: 1 }), h).catch((e) => e);
    expect(err).toMatchObject({ code: "EVAL_ENGINE_ERROR" });
    expect(h.results).toHaveLength(2);
  });

  it("getEngine returns the fake engine", async () => {
    const e = getEngine("fake");
    expect(e.name).toBe("fake");
    expect(await e.version()).toBe("fake");
    expect(() => getEngine("nope")).toThrow();
  });
});
