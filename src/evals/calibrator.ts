import { collectCalibrationSamples, type CalibrationStore } from "./calibration.js";
import { CONVERSATION_RUBRIC_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from "./constants.js";
import type { JudgedGrader } from "./judged.js";
import { computeCalibration, computeStability, type CalibrationStats, type StabilityStats } from "./stats.js";
import type {
  EvalCalibrationDisagreement,
  EvalCalibrationRow,
  EvalCalibrationSplit,
  EvalJson,
} from "./storeTypes.js";
import type { EngineIo, EvalEngine, EvalPlan, JudgeSettings, NormalizedGrade, PlanCase, RubricExample } from "./types.js";
import type { RunStore } from "../runstore/port.js";
import { EvalRunError } from "./errors.js";

export type CalibrateInput = {
  projectRoot: string;
  evalPath: string;
  graderId: string;
  split?: EvalCalibrationSplit;
  /** A rubric to measure instead of the saved one; the result is stored as a candidate. */
  candidate?: { rubric?: string; examples?: RubricExample[]; judge?: string; judgeSettings?: JudgeSettings };
  maxCostUsd?: number;
  /** Judge each output 3 times (or the grader's own larger vote count) and report how often the verdict splits. */
  stability?: boolean;
};

export type CalibrateResult = {
  calibration: EvalCalibrationRow;
  stats: CalibrationStats;
  disagreements: EvalCalibrationDisagreement[];
  errored: number;
  stability?: StabilityStats;
  costUsd: number;
};

export type CalibrationDeps = {
  store: CalibrationStore & Pick<RunStore, "insertEvalCalibration">;
  engine: EvalEngine;
  log: (level: "info" | "warn" | "error", message: string) => void;
};

export const CALIBRATION_DEFAULT_MAX_COST_USD = 1;

const key = (caseId: string, repeatIndex: number): string => `${caseId}:${repeatIndex}`;

/**
 * Re-judges the stored outputs of results the author labeled for one judged grader and compares the verdicts to the
 * labels. No stage or agent runs: the engine's case callback replays the stored output. `base` is the eval's built
 * plan and `found` is the saved grader; the caller owns the one-at-a-time claim and the work directory.
 */
export async function measureCalibration(
  { store, engine, log }: CalibrationDeps,
  input: CalibrateInput,
  base: EvalPlan,
  found: JudgedGrader,
  abort: AbortController,
): Promise<CalibrateResult> {
  let grader = found;
  if (input.candidate !== undefined) {
    if (grader.type === "rubric") {
      grader = {
        ...grader,
        ...(input.candidate.rubric !== undefined ? { rubric: input.candidate.rubric } : {}),
        ...(input.candidate.examples !== undefined ? { examples: input.candidate.examples } : {}),
        ...(input.candidate.judge !== undefined ? { judge: input.candidate.judge } : {}),
        ...(input.candidate.judgeSettings !== undefined
          ? { judgeSettings: { ...(grader.judgeSettings ?? {}), ...input.candidate.judgeSettings } }
          : {}),
      };
    } else {
      grader = {
        ...grader,
        ...(input.candidate.judge !== undefined ? { judge: input.candidate.judge } : {}),
        ...(input.candidate.judgeSettings !== undefined
          ? { judgeSettings: { ...(grader.judgeSettings ?? {}), ...input.candidate.judgeSettings } }
          : {}),
      };
    }
  }
  const stabilityVotes = input.stability === true ? Math.max(grader.judgeSettings?.votes ?? 1, 3) : undefined;
  if (stabilityVotes !== undefined) {
    grader = { ...grader, judgeSettings: { ...(grader.judgeSettings ?? {}), votes: stabilityVotes } };
  }
  const split = input.split ?? "all";
  const samples = await collectCalibrationSamples(store, input.projectRoot, base.evalId, grader.id, split);
  const casesById = new Map(base.cases.map((c) => [c.id, c]));
  const usable = samples.filter((s) => casesById.has(s.caseId));
  if (usable.length === 0) {
    throw new EvalRunError(
      "EVAL_CALIBRATION_NO_LABELS",
      `No labeled results for grader ${grader.id} can be re-judged; label results in a run first`,
    );
  }
  const replay = new Map(usable.map((s) => [key(s.caseId, s.repeatIndex), s]));
  const plan: EvalPlan = {
    ...base,
    cases: [...new Set(usable.map((s) => s.caseId))].map((id, position) => ({
      ...(casesById.get(id) as PlanCase),
      position,
    })),
    graders: [{ ...grader, weight: 1, mustPass: false }],
    repeats: Math.max(...usable.map((s) => s.repeatIndex)) + 1,
    maxCostUsd: input.maxCostUsd ?? CALIBRATION_DEFAULT_MAX_COST_USD,
  };
  let spend = 0;
  const verdicts = new Map<string, NormalizedGrade>();
  const io: EngineIo = {
    runCase: async (req) => {
      const sample = replay.get(key(req.caseId, req.repeatIndex));
      if (!sample) {
        return { ok: false, code: "EVAL_ENGINE_ERROR", message: "not labeled for this grader" };
      }
      return { ok: true, output: sample.output, latencyMs: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
    },
    onResult: (nr) => {
      const grade = nr.grades.find((g) => g.graderId === grader.id);
      if (grade) verdicts.set(key(nr.caseId, nr.repeatIndex), grade);
      if (grade?.judgeCostUsd !== undefined && Number.isFinite(grade.judgeCostUsd)) spend += grade.judgeCostUsd;
      if (spend >= plan.maxCostUsd) abort.abort();
    },
    reportJudgeCost: () => undefined,
    onPhase: () => undefined,
    log: (level, message) => {
      if (level === "info") log("info", message);
      else log(level, message);
    },
  };
  await engine.run(plan, io, abort.signal);

  const voteSets: boolean[][] = [];
  const measured: Array<{ caseId: string; repeatIndex: number; label: boolean; judge: boolean }> = [];
  const disagreements: EvalCalibrationDisagreement[] = [];
  let errored = 0;
  for (const s of usable) {
    const grade = verdicts.get(key(s.caseId, s.repeatIndex));
    if (!grade || grade.status !== "graded" || grade.passed === undefined) {
      errored++;
      continue;
    }
    const label = s.label === "pass";
    const votes = (grade.details as { votes?: Array<{ status?: string; passed?: boolean }> } | undefined)?.votes;
    if (Array.isArray(votes)) {
      voteSets.push(votes.filter((v) => v.status === "graded" && typeof v.passed === "boolean").map((v) => v.passed as boolean));
    }
    measured.push({ caseId: s.caseId, repeatIndex: s.originalRepeatIndex, label, judge: grade.passed });
    if (label !== grade.passed) {
      disagreements.push({
        evalRunId: s.originalRunId,
        caseId: s.caseId,
        repeatIndex: s.originalRepeatIndex,
        label: s.label,
        judge: grade.passed ? "pass" : "fail",
        reason: grade.reason ?? null,
      });
    }
  }
  const stats = computeCalibration(measured);
  const stability = stabilityVotes !== undefined ? computeStability(voteSets, stabilityVotes) : undefined;
  const calibration = await store.insertEvalCalibration({
    projectRoot: input.projectRoot,
    evalId: base.evalId,
    graderId: grader.id,
    graderHash: found.hash,
    judge: grader.judge,
    promptVersion: base.target.kind === "agent" ? CONVERSATION_RUBRIC_PROMPT_VERSION : RUBRIC_PROMPT_VERSION,
    split,
    candidate: input.candidate !== undefined,
    stats: {
      ...stats,
      errored,
      skipped_missing_case: samples.length - usable.length,
      ...(stability !== undefined ? { stability } : {}),
    } as unknown as EvalJson,
    disagreements,
    costUsd: spend,
  });
  return { calibration, stats, disagreements, errored, ...(stability !== undefined ? { stability } : {}), costUsd: spend };
}
