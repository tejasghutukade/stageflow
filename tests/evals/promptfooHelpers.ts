import type { CaseOutput, EngineIo, EvalPlan, NormalizedResult, RunCaseRequest, RunCaseResult } from "../../src/evals/types.js";

export function samplePlan(overrides: Partial<EvalPlan> = {}): EvalPlan {
  return {
    evalRunId: "run-1",
    projectRoot: "/project",
    evalId: "sample",
    target: { kind: "stage", file: "stages/s.yaml" },
    targetVersionHash: "tv",
    stageModel: "anthropic/claude-x",
    task: { goal: "do it" },
    cases: [
      { id: "c1", position: 0, input: { q: "a" }, expected: { answer: 7 }, tags: [] },
      { id: "c2", position: 1, input: { q: "b" }, expected: { answer: 42 }, tags: [] },
    ],
    graders: [
      {
        id: "field_answer",
        type: "field",
        weight: 1,
        mustPass: false,
        hash: "h1",
        checks: [{ path: "payload.answer", op: "equals", value: 7 }],
      },
      {
        id: "quality",
        type: "rubric",
        weight: 1,
        mustPass: false,
        hash: "h2",
        rubric: "The summary is helpful",
        scale: "1_to_5",
        passAt: 4,
        judge: "openai/stub-judge",
        examples: [{ score: 5, output: "Clear and actionable", reason: "Specific" }],
      },
    ],
    repeats: 2,
    passThreshold: 0.8,
    concurrency: 2,
    maxCostUsd: 5,
    ...overrides,
  };
}

export const OK_OUTPUT: CaseOutput = {
  kind: "envelope",
  status: "success",
  summary: "meh summary",
  payload: { answer: 7 },
  artifacts: [],
};

export function okRun(caseId: string, repeatIndex: number): RunCaseResult {
  return {
    ok: true,
    stageRunId: `run-${caseId}-${repeatIndex}`,
    output: OK_OUTPUT,
    latencyMs: 250,
    costUsd: 0.0123,
    tokensIn: 1000,
    tokensOut: 200,
  };
}

export type RecordedIo = {
  io: EngineIo;
  results: NormalizedResult[];
  logs: Array<{ level: string; message: string }>;
  phases: string[];
  judgeCost: number[];
};

export function recordingIo(
  runCase: (req: RunCaseRequest) => Promise<RunCaseResult> = async (req) => okRun(req.caseId, req.repeatIndex),
): RecordedIo {
  const results: NormalizedResult[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const phases: string[] = [];
  const judgeCost: number[] = [];
  return {
    results,
    logs,
    phases,
    judgeCost,
    io: {
      runCase,
      onResult: (r) => results.push(r),
      reportJudgeCost: (usd) => judgeCost.push(usd),
      onPhase: (caseId, repeatIndex, phase) => phases.push(`${caseId}#${repeatIndex}:${phase}`),
      log: (level, message) => logs.push({ level, message }),
    },
  };
}
