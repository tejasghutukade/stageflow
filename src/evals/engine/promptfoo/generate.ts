import { GUARD_FILENAME, GUARD_SOURCE } from "./guard.js";
import { EngineError } from "./errors.js";
import { mapJudge, unsupportedJudgeMessage } from "../../judgeProviders.js";
import { caseGoal, goalRubricText } from "../../graders/goal.js";
import { VOTE_METRIC_SEPARATOR } from "./normalize.js";
import { escapeTemplate, renderConversationRubricPrompt, renderRubricPrompt } from "./rubricPrompt.js";
import type { EvalPlan, PlanCase, ResolvedGrader } from "../../types.js";

export const CALLBACK_URL_ENV = "STAGEFLOW_EVAL_CALLBACK_URL";
export const RUN_TOKEN_ENV = "STAGEFLOW_EVAL_TOKEN";

export const CONFIG_FILE = "promptfooconfig.json";
export const PROVIDER_FILE = "provider.mjs";
export const ASSERTIONS_FILE = "assertions.mjs";
export const HOOKS_FILE = "hooks.mjs";
export const DATASET_FILE = "dataset.json";
export const RESULTS_STREAM_FILE = "results.ndjson";
export const RESULTS_FILE = "results.json";

export const EMPTY_EXPECTED = "(none)";

export type GenerateOptions = {
  graderModuleUrl: string;
  judgeProviderConfig?: Record<string, unknown>;
};

export type GeneratedFiles = {
  [CONFIG_FILE]: string;
  [PROVIDER_FILE]: string;
  [ASSERTIONS_FILE]: string;
  [HOOKS_FILE]: string;
  [DATASET_FILE]: string;
  [GUARD_FILENAME]: string;
};

export function assertionFnName(index: number): string {
  return `grader${index}`;
}

export function buildProviderSource(evalRunId: string, agent = false): string {
  const okMeta = agent
    ? `
            subjectRef: reply.subjectRef,
            turns: reply.output && reply.output.turns,
            toolCallCount: reply.output && Array.isArray(reply.output.tool_calls) ? reply.output.tool_calls.length : undefined,`
    : "";
  const failKeys = agent ? '["stageRunId", "subjectRef", "latencyMs", "costUsd"]' : '["stageRunId", "latencyMs", "costUsd"]';
  return `import http from "node:http";

const EVAL_RUN_ID = ${JSON.stringify(evalRunId)};

function post(url, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: "Bearer " + token,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export default class StageflowHostProvider {
  id() {
    return "stageflow-host";
  }

  async callApi(_prompt, context) {
    const caseId = String(context?.vars?.caseId ?? "");
    const index = context?.repeatIndex ?? context?.vars?.__repeatIndex;
    const repeatIndex = Number.isInteger(index) ? index : 0;
    const base = { caseId, repeatIndex };
    const failure = (code, message, extra = {}) => ({
      error: code + ": " + message,
      metadata: { ...base, errorCode: code, ...extra },
    });
    try {
      const url = process.env.${CALLBACK_URL_ENV};
      const token = process.env.${RUN_TOKEN_ENV};
      if (!url || !token) return failure("EVAL_ENGINE_ERROR", "host callback is not configured");
      const res = await post(url, token, { eval_run_id: EVAL_RUN_ID, case_id: caseId, repeat_index: repeatIndex });
      if (res.status !== 200) return failure("EVAL_ENGINE_ERROR", "host callback answered " + res.status);
      let reply;
      try {
        reply = JSON.parse(res.body);
      } catch {
        return failure("EVAL_ENGINE_ERROR", "host callback reply is not JSON");
      }
      if (reply && reply.ok === true) {
        return {
          output: JSON.stringify(reply.output),
          metadata: {
            ...base,
            stageRunId: reply.stageRunId,${okMeta}
            latencyMs: reply.latencyMs,
            costUsd: reply.costUsd,
            tokensIn: reply.tokensIn,
            tokensOut: reply.tokensOut,
          },
        };
      }
      const extra = {};
      for (const key of ${failKeys}) {
        if (reply && reply[key] !== undefined) extra[key] = reply[key];
      }
      return failure(
        typeof reply?.code === "string" ? reply.code : "EVAL_ENGINE_ERROR",
        typeof reply?.message === "string" ? reply.message : "stage case failed",
        extra,
      );
    } catch {
      return failure("EVAL_ENGINE_ERROR", "host callback failed");
    }
  }
}
`;
}

export function buildHooksSource(agent = false): string {
  const metaKeys = agent
    ? '["caseId", "repeatIndex", "stageRunId", "subjectRef", "turns", "toolCallCount", "latencyMs", "costUsd", "tokensIn", "tokensOut", "errorCode"]'
    : '["caseId", "repeatIndex", "stageRunId", "latencyMs", "costUsd", "tokensIn", "tokensOut", "errorCode"]';
  return `import { appendFileSync } from "node:fs";

const STREAM = new URL(${JSON.stringify(RESULTS_STREAM_FILE)}, import.meta.url);
const META_KEYS = ${metaKeys};

function pickMeta(meta) {
  const out = {};
  if (meta && typeof meta === "object") {
    for (const key of META_KEYS) if (meta[key] !== undefined) out[key] = meta[key];
  }
  return out;
}

function pickComponent(c) {
  const graderError = c?.metadata?.graderError === true;
  return {
    metric: c?.assertion?.metric,
    type: c?.assertion?.type,
    pass: c?.pass === true,
    score: typeof c?.score === "number" ? c.score : undefined,
    reason: graderError || typeof c?.reason !== "string" ? undefined : c.reason,
    tokensIn: typeof c?.tokensUsed?.prompt === "number" ? c.tokensUsed.prompt : undefined,
    tokensOut: typeof c?.tokensUsed?.completion === "number" ? c.tokensUsed.completion : undefined,
    graderError,
    errorCode: typeof c?.metadata?.errorCode === "string" ? c.metadata.errorCode : undefined,
    stageflow: c?.metadata?.stageflow,
  };
}

export async function afterEach(context) {
  try {
    const r = context?.result ?? {};
    const record = {
      testIdx: r.testIdx,
      caseId: typeof r.vars?.caseId === "string" ? r.vars.caseId : undefined,
      failureReason: r.failureReason,
      metadata: pickMeta(r.response?.metadata ?? r.metadata),
      output: typeof r.response?.output === "string" ? r.response.output : undefined,
      providerError: typeof r.response?.error === "string" ? r.response.error : undefined,
      components: (r.gradingResult?.componentResults ?? []).map(pickComponent),
    };
    appendFileSync(STREAM, JSON.stringify(record) + "\\n");
  } catch {
    return;
  }
}
`;
}

const STAGE_TO_SUBJECT = `function toSubject(output) {
  const value = typeof output === "string" ? JSON.parse(output) : output;
  return {
    status: value.status,
    summary: value.summary,
    ...(value.payload !== undefined ? { payload: value.payload } : {}),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
  };
}`;

const AGENT_TO_SUBJECT = `function toSubject(output) {
  const value = typeof output === "string" ? JSON.parse(output) : output;
  if (value.kind === "conversation") {
    const { transcript: _transport, ...subject } = value;
    return subject;
  }
  return {
    status: value.status,
    summary: value.summary,
    ...(value.payload !== undefined ? { payload: value.payload } : {}),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
  };
}`;

const MISSING_GOAL_GRADE = `function missingGoal(index) {
  return {
    pass: false,
    score: 0,
    reason: "EVAL_CASE_MISSING_EXPECTED",
    metadata: {
      graderError: true,
      errorCode: "EVAL_CASE_MISSING_EXPECTED",
      stageflow: {
        graderId: GRADERS[index].id,
        graderType: GRADERS[index].type,
        status: "error",
        errorCode: "EVAL_CASE_MISSING_EXPECTED",
        reason: "case has no input.goal or expected.outcome",
      },
    },
  };
}

`;

function isJudged(grader: ResolvedGrader): grader is Extract<ResolvedGrader, { type: "rubric" | "goal_reached" }> {
  return grader.type === "rubric" || grader.type === "goal_reached";
}

export function buildAssertionsSource(plan: EvalPlan, graderModuleUrl: string): string {
  const agent = plan.target.kind === "agent";
  const graders = plan.graders.map((g, index) => ({ index, grader: g }));
  const exports = graders
    .filter(({ grader }) => grader.type !== "rubric" && (agent || grader.type !== "goal_reached"))
    .map(({ index }) => `export const ${assertionFnName(index)} = (output, context) => run(${index}, output, context);`);
  return `import { readFileSync } from "node:fs";
import { gradeDeterministic } from ${JSON.stringify(graderModuleUrl)};

const GRADERS = ${JSON.stringify(plan.graders)};
const BASE_CONTEXT = ${JSON.stringify({
    evalId: plan.evalId,
    runId: plan.evalRunId,
    passThreshold: plan.passThreshold,
    ...(plan.outputSchema !== undefined ? { outputSchema: plan.outputSchema } : {}),
  })};
const CASES = new Map(
  JSON.parse(readFileSync(new URL(${JSON.stringify(DATASET_FILE)}, import.meta.url), "utf8")).map((c) => [c.id, c]),
);

${agent ? AGENT_TO_SUBJECT : STAGE_TO_SUBJECT}

function engineError(index) {
  return {
    pass: false,
    score: 0,
    reason: "grader failed to run",
    metadata: {
      graderError: true,
      errorCode: "EVAL_ENGINE_ERROR",
      stageflow: { graderId: GRADERS[index].id, graderType: GRADERS[index].type, status: "error", errorCode: "EVAL_ENGINE_ERROR" },
    },
  };
}

${agent ? MISSING_GOAL_GRADE : ""}function run(index, output, context) {
  try {
    const grader = GRADERS[index];
${agent ? '    if (grader.type === "goal_reached") return missingGoal(index);\n' : ""}    const testCase = CASES.get(context?.vars?.caseId);
    if (!testCase) return engineError(index);
    const repeat = context?.providerResponse?.metadata?.repeatIndex;
    const grade = gradeDeterministic(grader, toSubject(output), testCase, {
      ...BASE_CONTEXT,
      repeat: Number.isInteger(repeat) ? repeat : 0,
    });
    if (grade.status === "error") {
      return {
        pass: false,
        score: 0,
        reason: grade.errorCode ?? "EVAL_ENGINE_ERROR",
        metadata: { graderError: true, errorCode: grade.errorCode ?? "EVAL_ENGINE_ERROR", stageflow: grade },
      };
    }
    return {
      pass: grade.passed === true,
      score: typeof grade.score === "number" ? grade.score : 0,
      reason: grade.reason ?? (grade.passed === true ? "passed" : "failed"),
      metadata: { stageflow: grade },
    };
  } catch {
    return engineError(index);
  }
}

${exports.join("\n")}
`;
}

/** The metric of vote `n` (1-based) for a judged grader; vote 1 keeps the grader id. */
export function voteMetric(graderId: string, vote: number): string {
  return vote === 1 ? graderId : `${graderId}${VOTE_METRIC_SEPARATOR}${vote}`;
}

function judgeAssertions(
  grader: Extract<ResolvedGrader, { type: "rubric" | "goal_reached" }>,
  options: GenerateOptions,
  agent: boolean,
  testCase: PlanCase,
): Array<Record<string, unknown>> {
  const votes = grader.judgeSettings?.votes ?? 1;
  return Array.from({ length: votes }, (_, i) => judgeAssertion(grader, options, agent, testCase, voteMetric(grader.id, i + 1)));
}

function judgeAssertion(
  grader: Extract<ResolvedGrader, { type: "rubric" | "goal_reached" }>,
  options: GenerateOptions,
  agent: boolean,
  testCase: PlanCase,
  metric: string,
): Record<string, unknown> {
  const mapping = mapJudge(grader.judge);
  if (mapping === null) throw new EngineError("EVAL_INVALID", unsupportedJudgeMessage(grader.judge));
  const reasoning = grader.judgeSettings?.reasoning;
  let rubric: string;
  let prompt: string;
  if (grader.type === "goal_reached") {
    rubric = escapeTemplate(goalRubricText(caseGoal(testCase) ?? "", grader.guidance));
    prompt = renderConversationRubricPrompt({ scale: "pass_fail", examples: [], ...(reasoning ? { reasoning } : {}) });
  } else {
    rubric = grader.rubric;
    const withSettings = reasoning ? { ...grader, reasoning } : grader;
    prompt = agent ? renderConversationRubricPrompt(withSettings) : renderRubricPrompt(withSettings);
  }
  const temperature = grader.judgeSettings?.temperature;
  const providerConfig =
    temperature === undefined ? options.judgeProviderConfig : { ...(options.judgeProviderConfig ?? {}), temperature };
  return {
    type: "llm-rubric",
    value: rubric,
    metric,
    weight: 1,
    rubricPrompt: prompt,
    provider:
      providerConfig === undefined ? mapping.providerSpec : { id: mapping.providerSpec, config: providerConfig },
  };
}

function assertionsFor(
  plan: EvalPlan,
  options: GenerateOptions,
  testCase: PlanCase,
): Array<Record<string, unknown>> {
  const agent = plan.target.kind === "agent";
  return plan.graders.flatMap((grader, index) => {
    if (isJudged(grader) && !(grader.type === "goal_reached" && caseGoal(testCase) === undefined)) {
      return judgeAssertions(grader, options, agent, testCase);
    }
    return [
      {
        type: "javascript",
        value: `file://${ASSERTIONS_FILE}:${assertionFnName(index)}`,
        metric: grader.id,
        weight: 1,
      },
    ];
  });
}

export function buildConfig(plan: EvalPlan, options: GenerateOptions): Record<string, unknown> {
  const agent = plan.target.kind === "agent";
  const shared = agent ? undefined : assertionsFor(plan, options, plan.cases[0] ?? ({ input: {} } as PlanCase));
  return {
    description: `Stageflow eval ${plan.evalId}`,
    prompts: ["{{caseId}}"],
    providers: [{ id: `file://${PROVIDER_FILE}` }],
    extensions: [`file://${HOOKS_FILE}:afterEach`],
    tests: plan.cases.map((c) => ({
      description: c.id,
      vars: {
        caseId: c.id,
        input: JSON.stringify(c.input),
        expected: c.expected === undefined ? EMPTY_EXPECTED : JSON.stringify(c.expected),
      },
      assert: shared ?? assertionsFor(plan, options, c),
    })),
  };
}

export function generateFiles(plan: EvalPlan, options: GenerateOptions): GeneratedFiles {
  return {
    [CONFIG_FILE]: `${JSON.stringify(buildConfig(plan, options), null, 2)}\n`,
    [PROVIDER_FILE]: buildProviderSource(plan.evalRunId, plan.target.kind === "agent"),
    [ASSERTIONS_FILE]: buildAssertionsSource(plan, options.graderModuleUrl),
    [HOOKS_FILE]: buildHooksSource(plan.target.kind === "agent"),
    [DATASET_FILE]: `${JSON.stringify(plan.cases, null, 2)}\n`,
    [GUARD_FILENAME]: GUARD_SOURCE,
  };
}
