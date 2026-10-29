import { CONVERSATION_RUBRIC_PROMPT_VERSION } from "../../constants.js";
import { combineVotes, JUDGE_ERROR_CODE } from "../../votes.js";
import type {
  CaseOutput,
  EvalPlan,
  NormalizedGrade,
  NormalizedResult,
  ResolvedGrader,
  RunCaseFailureCode,
  RunCaseResult,
} from "../../types.js";

export type RecordMetadata = {
  caseId?: string;
  repeatIndex?: number;
  stageRunId?: string;
  subjectRef?: string;
  turns?: number;
  toolCallCount?: number;
  latencyMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  errorCode?: string;
};

export type RecordComponent = {
  metric?: string;
  type?: string;
  pass: boolean;
  score?: number;
  reason?: string;
  tokensIn?: number;
  tokensOut?: number;
  graderError: boolean;
  errorCode?: string;
  stageflow?: unknown;
};

export type ResultRecord = {
  testIdx?: number;
  caseId?: string;
  failureReason?: number;
  metadata: RecordMetadata;
  output?: string;
  providerError?: string;
  components: RecordComponent[];
};

export type JudgePrice = { inputPerMillion: number; outputPerMillion: number };

export type NormalizeContext = {
  hostRun?: (caseId: string, repeatIndex: number) => RunCaseResult | undefined;
  judgePrice?: (modelId: string) => JudgePrice | undefined;
};

/** Votes after the first are separate assertions whose metric is the grader id, this, and the vote number. */
export const VOTE_METRIC_SEPARATOR = "#vote";

export { JUDGE_ERROR_CODE };
export const ENGINE_ERROR_CODE = "EVAL_ENGINE_ERROR";

const META_KEYS = [
  "caseId",
  "repeatIndex",
  "stageRunId",
  "subjectRef",
  "turns",
  "toolCallCount",
  "latencyMs",
  "costUsd",
  "tokensIn",
  "tokensOut",
  "errorCode",
] as const;

const FAILURE_CODES: readonly RunCaseFailureCode[] = [
  "EVAL_STAGE_FAILED",
  "EVAL_STAGE_NEEDS_INPUT",
  "EVAL_STAGE_TIMEOUT",
  "EVAL_AGENT_FAILED",
  "EVAL_AGENT_EMPTY_REPLY",
  "EVAL_AGENT_TIMEOUT",
  "EVAL_SIMULATOR_ERROR",
  "EVAL_BUDGET_EXCEEDED",
  "EVAL_CANCELLED",
  "EVAL_ENGINE_ERROR",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickMetadata(value: unknown): RecordMetadata {
  const out: Record<string, unknown> = {};
  if (isObject(value)) {
    for (const key of META_KEYS) if (value[key] !== undefined) out[key] = value[key];
  }
  return out as RecordMetadata;
}

function pickComponent(value: unknown): RecordComponent {
  const c = isObject(value) ? value : {};
  const assertion = isObject(c.assertion) ? c.assertion : {};
  const metadata = isObject(c.metadata) ? c.metadata : {};
  const tokens = isObject(c.tokensUsed) ? c.tokensUsed : {};
  const graderError = metadata.graderError === true;
  return {
    ...(str(assertion.metric) !== undefined ? { metric: str(assertion.metric) } : {}),
    ...(str(assertion.type) !== undefined ? { type: str(assertion.type) } : {}),
    pass: c.pass === true,
    ...(num(c.score) !== undefined ? { score: num(c.score) } : {}),
    ...(!graderError && str(c.reason) !== undefined ? { reason: str(c.reason) } : {}),
    ...(num(tokens.prompt) !== undefined ? { tokensIn: num(tokens.prompt) } : {}),
    ...(num(tokens.completion) !== undefined ? { tokensOut: num(tokens.completion) } : {}),
    graderError,
    ...(str(metadata.errorCode) !== undefined ? { errorCode: str(metadata.errorCode) } : {}),
    ...(metadata.stageflow !== undefined ? { stageflow: metadata.stageflow } : {}),
  };
}

export function recordFromPromptfooResult(raw: unknown): ResultRecord {
  const r = isObject(raw) ? raw : {};
  const response = isObject(r.response) ? r.response : undefined;
  const vars = isObject(r.vars) ? r.vars : {};
  const grading = isObject(r.gradingResult) ? r.gradingResult : {};
  const components = Array.isArray(grading.componentResults) ? grading.componentResults : [];
  return {
    ...(num(r.testIdx) !== undefined ? { testIdx: num(r.testIdx) } : {}),
    ...(str(vars.caseId) !== undefined ? { caseId: str(vars.caseId) } : {}),
    ...(num(r.failureReason) !== undefined ? { failureReason: num(r.failureReason) } : {}),
    metadata: pickMetadata(response?.metadata ?? r.metadata),
    ...(str(response?.output) !== undefined ? { output: str(response?.output) } : {}),
    ...(str(response?.error) !== undefined ? { providerError: str(response?.error) } : {}),
    components: components.map(pickComponent),
  };
}

export function recordsFromResultsFile(parsed: unknown): ResultRecord[] | undefined {
  if (!isObject(parsed) || !isObject(parsed.results)) return undefined;
  const list = parsed.results.results;
  return Array.isArray(list) ? list.map(recordFromPromptfooResult) : undefined;
}

export function recordIdentity(
  record: ResultRecord,
  plan: Pick<EvalPlan, "cases" | "repeats">,
): { caseId: string; repeatIndex: number } | undefined {
  const caseId = record.caseId ?? record.metadata.caseId;
  if (caseId === undefined || !plan.cases.some((c) => c.id === caseId)) return undefined;
  const echoed = record.metadata.repeatIndex;
  if (typeof echoed === "number" && Number.isInteger(echoed) && echoed >= 0) {
    return { caseId, repeatIndex: echoed };
  }
  if (record.testIdx === undefined || plan.repeats < 1) return undefined;
  return { caseId, repeatIndex: record.testIdx % plan.repeats };
}

function runFromRecord(record: ResultRecord): RunCaseResult {
  const meta = record.metadata;
  if (record.output !== undefined && record.providerError === undefined) {
    let output: CaseOutput | undefined;
    try {
      const parsed: unknown = JSON.parse(record.output);
      if (isObject(parsed) && (parsed.status === "success" || parsed.status === "failure")) {
        output = parsed as CaseOutput;
      }
    } catch {
      output = undefined;
    }
    const joined = meta.stageRunId ?? meta.subjectRef;
    if (output !== undefined && joined !== undefined) {
      return {
        ok: true,
        ...(meta.subjectRef !== undefined ? { subjectRef: meta.subjectRef } : {}),
        ...(meta.stageRunId !== undefined ? { stageRunId: meta.stageRunId } : {}),
        output,
        latencyMs: meta.latencyMs ?? 0,
        costUsd: meta.costUsd ?? 0,
        tokensIn: meta.tokensIn ?? 0,
        tokensOut: meta.tokensOut ?? 0,
      };
    }
  }
  const code = FAILURE_CODES.find((c) => c === meta.errorCode) ?? "EVAL_ENGINE_ERROR";
  const colon = record.providerError?.indexOf(": ") ?? -1;
  const message =
    record.providerError !== undefined && colon >= 0
      ? record.providerError.slice(colon + 2)
      : "Engine result could not be matched to a stage run";
  return {
    ok: false,
    code,
    message,
    ...(meta.subjectRef !== undefined ? { subjectRef: meta.subjectRef } : {}),
    ...(meta.stageRunId !== undefined ? { stageRunId: meta.stageRunId } : {}),
    ...(meta.latencyMs !== undefined ? { latencyMs: meta.latencyMs } : {}),
    ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
  };
}

function errorGrade(grader: ResolvedGrader, errorCode: string): NormalizedGrade {
  return { graderId: grader.id, graderType: grader.type, status: "error", errorCode };
}

function isGradeShape(value: unknown, grader: ResolvedGrader): value is NormalizedGrade {
  return (
    isObject(value) &&
    value.graderId === grader.id &&
    (value.status === "graded" || value.status === "error")
  );
}

function deterministicGrade(grader: ResolvedGrader, component: RecordComponent): NormalizedGrade {
  if (component.graderError) {
    const fromGrade = isGradeShape(component.stageflow, grader) ? component.stageflow : undefined;
    return fromGrade?.status === "error"
      ? fromGrade
      : errorGrade(grader, component.errorCode ?? ENGINE_ERROR_CODE);
  }
  if (isGradeShape(component.stageflow, grader)) return component.stageflow;
  const score = component.score ?? (component.pass ? 1 : 0);
  return {
    graderId: grader.id,
    graderType: grader.type,
    status: "graded",
    passed: component.pass,
    score,
    rawValue: score,
    ...(component.reason !== undefined ? { reason: component.reason } : {}),
  };
}

export type RubricGradeResult = { grade: NormalizedGrade; priceUnknown: boolean };

type JudgedGrader = {
  id: string;
  type: "rubric" | "goal_reached";
  judge: string;
  scale: "pass_fail" | "1_to_5";
  passAt: number;
};

function judgedView(grader: Extract<ResolvedGrader, { type: "rubric" | "goal_reached" }>): JudgedGrader {
  return grader.type === "rubric"
    ? grader
    : { id: grader.id, type: "goal_reached", judge: grader.judge, scale: "pass_fail", passAt: 1 };
}

function rubricGrade(
  grader: JudgedGrader,
  component: RecordComponent,
  judgePrice: NormalizeContext["judgePrice"],
  conversation: boolean,
): RubricGradeResult {
  const tokensIn = component.tokensIn ?? 0;
  const tokensOut = component.tokensOut ?? 0;
  const price = judgePrice?.(grader.judge);
  const judged: NormalizedGrade = {
    graderId: grader.id,
    graderType: grader.type,
    status: "graded",
    judgeModel: grader.judge,
    judgeTokensIn: tokensIn,
    judgeTokensOut: tokensOut,
    judgeCostUsd:
      price === undefined
        ? 0
        : (tokensIn * price.inputPerMillion + tokensOut * price.outputPerMillion) / 1_000_000,
  };
  const variant = conversation
    ? { promptVariant: "conversation", promptVersion: CONVERSATION_RUBRIC_PROMPT_VERSION }
    : undefined;
  const withUnknownPrice = (g: NormalizedGrade): RubricGradeResult => {
    const unknown = price === undefined && tokensIn + tokensOut > 0;
    const details = { ...(variant ?? {}), ...(unknown ? { judgeCostUnknown: true } : {}) };
    return {
      grade: Object.keys(details).length > 0 ? { ...g, details } : g,
      priceUnknown: unknown,
    };
  };
  const bad = (): RubricGradeResult =>
    withUnknownPrice({ ...judged, status: "error", errorCode: JUDGE_ERROR_CODE });

  if (component.graderError) return bad();
  const reason = component.reason;
  if (grader.scale === "1_to_5") {
    const raw = component.score;
    if (raw === undefined || !Number.isFinite(raw) || raw < 1 || raw > 5) return bad();
    return withUnknownPrice({
      ...judged,
      rawValue: raw,
      score: (raw - 1) / 4,
      passed: raw >= grader.passAt,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return withUnknownPrice({
    ...judged,
    rawValue: component.pass ? 1 : 0,
    score: component.pass ? 1 : 0,
    passed: component.pass,
    ...(reason !== undefined ? { reason } : {}),
  });
}

export type NormalizeOutcome = {
  result: NormalizedResult;
  judgeCostUsd: number;
  priceUnknownModels: string[];
};

export function normalizeRecord(
  record: ResultRecord,
  identity: { caseId: string; repeatIndex: number },
  plan: Pick<EvalPlan, "graders"> & { target?: EvalPlan["target"] },
  ctx: NormalizeContext = {},
): NormalizeOutcome {
  const run = ctx.hostRun?.(identity.caseId, identity.repeatIndex) ?? runFromRecord(record);
  const grades: NormalizedGrade[] = [];
  const priceUnknownModels: string[] = [];
  let judgeCostUsd = 0;
  if (run.ok) {
    const byMetric = new Map<string, RecordComponent>();
    if (record.failureReason !== 2) {
      for (const component of record.components) {
        if (component.metric !== undefined) byMetric.set(component.metric, component);
      }
    }
    for (const grader of plan.graders) {
      const component = byMetric.get(grader.id);
      if (component === undefined) {
        grades.push(errorGrade(grader, ENGINE_ERROR_CODE));
      } else if (
        (grader.type === "rubric" || grader.type === "goal_reached") &&
        component.type !== "javascript"
      ) {
        const view = judgedView(grader);
        const conversation = plan.target?.kind === "agent";
        const components = [component];
        for (let vote = 2; vote <= (grader.judgeSettings?.votes ?? 1); vote++) {
          const extra = byMetric.get(`${grader.id}${VOTE_METRIC_SEPARATOR}${vote}`);
          if (extra !== undefined) components.push(extra);
        }
        const results = components.map((comp) => rubricGrade(view, comp, ctx.judgePrice, conversation));
        const grade = combineVotes(view, results.map((r) => r.grade));
        if (results.some((r) => r.priceUnknown) && !priceUnknownModels.includes(grader.judge)) {
          priceUnknownModels.push(grader.judge);
        }
        judgeCostUsd += grade.judgeCostUsd ?? 0;
        grades.push(grade);
      } else {
        grades.push(deterministicGrade(grader, component));
      }
    }
  }
  return {
    result: { caseId: identity.caseId, repeatIndex: identity.repeatIndex, run, grades },
    judgeCostUsd,
    priceUnknownModels,
  };
}
