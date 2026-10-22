import { gradeDeterministic, isDeterministicGrader } from "../graders/index.js";
import type { GraderContext, Subject } from "../graders/types.js";
import type {
  CaseOutput,
  EngineIo,
  EvalEngine,
  EvalPlan,
  NormalizedGrade,
  NormalizedResult,
  PlanCase,
  ResolvedGrader,
} from "../types.js";

export type FakeJudgeReply = (
  | { verdict: "pass" | "fail" }
  | { score: number }
) & { reason?: string };

export type FakeEnginePhase = "stage_running" | "agent_running" | "grading" | "done";

export type FakeEngineOptions = {
  judge?: (
    grader: Extract<ResolvedGrader, { type: "rubric" }>,
    testCase: PlanCase,
    output: CaseOutput,
  ) => FakeJudgeReply;
  judgeCostUsd?: number;
  order?: "sequential" | "shuffled";
  seed?: number;
  delayMs?: Partial<Record<FakeEnginePhase, number>>;
  failEngineAfter?: number;
  codeTimeoutMs?: number;
  version?: string;
};

export class FakeEngineError extends Error {
  readonly code = "EVAL_ENGINE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "FakeEngineError";
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSubject(output: CaseOutput): Subject {
  if (output.kind === "conversation") {
    return { status: output.status, summary: output.summary, artifacts: [] };
  }
  return {
    status: output.status,
    summary: output.summary,
    ...(output.payload !== undefined ? { payload: output.payload } : {}),
    artifacts: output.artifacts,
  };
}

export class FakeEngine implements EvalEngine {
  readonly name = "fake";

  constructor(private readonly options: FakeEngineOptions = {}) {}

  async version(): Promise<string> {
    return this.options.version ?? "fake";
  }

  async run(plan: EvalPlan, io: EngineIo, signal: AbortSignal): Promise<void> {
    const opts = this.options;
    const items: Array<{ testCase: PlanCase; repeatIndex: number }> = [];
    for (const testCase of plan.cases) {
      for (let repeatIndex = 0; repeatIndex < plan.repeats; repeatIndex++) {
        items.push({ testCase, repeatIndex });
      }
    }
    if (opts.order === "shuffled") {
      const rand = mulberry32(opts.seed ?? 1);
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }

    let next = 0;
    let emitted = 0;
    let stop = false;
    let failure: unknown;

    const phase = async (
      testCase: PlanCase,
      repeatIndex: number,
      p: FakeEnginePhase,
    ): Promise<void> => {
      io.onPhase(testCase.id, repeatIndex, p);
      const delay = opts.delayMs?.[p];
      if (delay) await sleep(delay);
    };

    const worker = async (): Promise<void> => {
      while (!stop && !signal.aborted && next < items.length) {
        if (opts.failEngineAfter !== undefined && emitted >= opts.failEngineAfter) {
          throw new FakeEngineError(`fake engine failed after ${emitted} results`);
        }
        const { testCase, repeatIndex } = items[next++];
        await phase(testCase, repeatIndex, plan.target.kind === "agent" ? "agent_running" : "stage_running");
        const run = await io.runCase({ evalRunId: plan.evalRunId, caseId: testCase.id, repeatIndex });
        const grades: NormalizedGrade[] = [];
        if (run.ok) {
          io.onPhase(testCase.id, repeatIndex, "grading");
          if (opts.delayMs?.grading) await sleep(opts.delayMs.grading);
          const ctx: GraderContext = {
            evalId: plan.evalId,
            runId: plan.evalRunId,
            repeat: repeatIndex,
            passThreshold: plan.passThreshold,
            outputSchema: plan.outputSchema,
            ...(opts.codeTimeoutMs !== undefined ? { codeTimeoutMs: opts.codeTimeoutMs } : {}),
          };
          for (const grader of plan.graders) {
            if (grader.type === "rubric") {
              grades.push(this.gradeRubric(grader, testCase, run.output, io));
            } else if (isDeterministicGrader(grader)) {
              grades.push(gradeDeterministic(grader, toSubject(run.output), testCase, ctx));
            } else {
              grades.push({
                graderId: grader.id,
                graderType: grader.type,
                status: "error",
                errorCode: "EVAL_GRADER_NOT_APPLICABLE",
              });
            }
          }
        } else if (run.code === "EVAL_BUDGET_EXCEEDED") {
          stop = true;
        }
        const result: NormalizedResult = { caseId: testCase.id, repeatIndex, run, grades };
        io.onResult(result);
        emitted++;
        await phase(testCase, repeatIndex, "done");
      }
    };

    const workers = Array.from({ length: Math.max(1, plan.concurrency) }, () =>
      worker().catch((error: unknown) => {
        stop = true;
        failure ??= error;
      }),
    );
    await Promise.all(workers);
    if (failure !== undefined) throw failure;
  }

  private gradeRubric(
    grader: Extract<ResolvedGrader, { type: "rubric" }>,
    testCase: PlanCase,
    output: CaseOutput,
    io: EngineIo,
  ): NormalizedGrade {
    const base = { graderId: grader.id, graderType: "rubric", judgeModel: grader.judge } as const;
    const reply: FakeJudgeReply =
      this.options.judge?.(grader, testCase, output) ??
      (grader.scale === "1_to_5" ? { score: 5 } : { verdict: "pass" });
    const cost = this.options.judgeCostUsd ?? 0;
    io.reportJudgeCost(cost);
    const judged = { ...base, judgeCostUsd: cost };
    const reason = reply.reason;
    const bad = (why: string): NormalizedGrade => ({
      ...judged,
      status: "error",
      errorCode: "EVAL_JUDGE_ERROR",
      reason: why,
    });
    if (grader.scale === "1_to_5") {
      if (!("score" in reply) || !Number.isFinite(reply.score) || reply.score < 1 || reply.score > 5) {
        return bad("judge reply is not a score from 1 to 5");
      }
      return {
        ...judged,
        status: "graded",
        rawValue: reply.score,
        score: (reply.score - 1) / 4,
        passed: reply.score >= grader.passAt,
        ...(reason !== undefined ? { reason } : {}),
      };
    }
    if (!("verdict" in reply)) return bad("judge reply is not a pass or fail verdict");
    const passed = reply.verdict === "pass";
    return {
      ...judged,
      status: "graded",
      rawValue: passed ? 1 : 0,
      score: passed ? 1 : 0,
      passed,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}
