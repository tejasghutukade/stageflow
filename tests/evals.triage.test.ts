import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRIAGE_PROMPT_VERSION } from "../src/evals/constants.js";
import { buildSuggestionSummary, representatives } from "../src/evals/read/suggestions.js";
import { FakeSimulatorModel } from "../src/evals/runner/simulatorModel.js";
import { resolveTypesafeKey } from "../src/evals/triage/credentials.js";
import { JEV_MODEL_ID } from "../src/evals/triage/constants.js";
import { createJevClassifier } from "../src/evals/triage/jevClassifier.js";
import { createJudgeClassifier } from "../src/evals/triage/judgeClassifier.js";
import { buildTriageState } from "../src/evals/triage/stateBuilder.js";
import { ClassifierError, type SuggestionRow } from "../src/evals/triage/types.js";
import type { EvalResultWithGrades } from "../src/evals/storeTypes.js";
import { startSystemOneFixture, type SystemOneFixture } from "./helpers/systemOneFixture.js";

const fixtures: SystemOneFixture[] = [];
const tmps: string[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  for (const t of tmps.splice(0)) await rm(t, { recursive: true, force: true });
});

async function fixture(): Promise<SystemOneFixture> {
  const f = await startSystemOneFixture();
  fixtures.push(f);
  return f;
}

function suggestion(overrides: Partial<SuggestionRow>): SuggestionRow {
  return {
    id: "sg_x",
    evalRunId: "er_1",
    caseId: "c1",
    repeatIndex: 0,
    source: "jev",
    bucket: "agent_wrong",
    failureType: null,
    confidence: 0.9,
    bucketProbabilities: { agent_wrong: 0.9, grader_wrong: 0.03, case_wrong: 0.03, unclear: 0.04 },
    graderFalseAlarms: [],
    model: JEV_MODEL_ID,
    promptVersion: TRIAGE_PROMPT_VERSION,
    status: "pending",
    batchId: "sb_1",
    costUsd: 0,
    stateTruncated: false,
    createdAt: "2026-10-23T10:00:00.000Z",
    ...overrides,
  };
}

function result(overrides: Partial<EvalResultWithGrades> = {}): EvalResultWithGrades {
  return {
    evalRunId: "er_1",
    caseId: "c1",
    repeatIndex: 0,
    status: "completed",
    errorCode: null,
    errorMessage: null,
    stageRunId: null,
    subjectRef: null,
    turns: null,
    toolCallCount: null,
    output: { kind: "envelope", status: "success", summary: "done", payload: { verdict: "bad" }, artifacts: [] },
    latencyMs: 1,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    score: 0,
    passed: false,
    hasGraderErrors: false,
    budgetWarnings: null,
    startedAt: null,
    finishedAt: null,
    grades: [
      {
        evalRunId: "er_1", caseId: "c1", repeatIndex: 0, graderId: "verdict-ok", graderType: "field", status: "graded",
        passed: true, score: 1, rawValue: null, reason: "ok", details: null, errorCode: null, judgeModel: null,
        judgeCostUsd: null, judgeTokensIn: null, judgeTokensOut: null,
      },
      {
        evalRunId: "er_1", caseId: "c1", repeatIndex: 0, graderId: "polite", graderType: "rubric", status: "graded",
        passed: false, score: 0, rawValue: null, reason: "Too curt", details: null, errorCode: null, judgeModel: "a/b",
        judgeCostUsd: null, judgeTokensIn: null, judgeTokensOut: null,
      },
    ],
    ...overrides,
  };
}

describe("suggestion summary", () => {
  it("counts per result with hand-computed numbers", () => {
    const rows = [
      suggestion({ id: "a", caseId: "c1", source: "jev", confidence: 0.9, failureType: "missing_tool_call", createdAt: "2026-10-23T10:00:00.000Z" }),
      suggestion({ id: "b", caseId: "c1", source: "judge", confidence: 0.6, failureType: "tone", createdAt: "2026-10-23T11:00:00.000Z" }),
      suggestion({ id: "c", caseId: "c2", bucket: "grader_wrong", confidence: 0.5, failureType: "wrong_or_missing_fact" }),
      suggestion({ id: "d", caseId: "c3", bucket: "unclear", confidence: 0.9, failureType: "other", status: "accepted" }),
      suggestion({ id: "e", caseId: "c4", bucket: "case_wrong", confidence: 0.8, failureType: null, status: "dismissed" }),
      suggestion({ id: "f", caseId: "c5", bucket: "agent_wrong", confidence: 0.7, failureType: "tone" }),
    ];
    expect(representatives(rows).map((r) => r.id).sort()).toEqual(["b", "c", "d", "e", "f"]);
    expect(buildSuggestionSummary(rows)).toEqual({
      by_bucket: { agent_wrong: 2, grader_wrong: 1, case_wrong: 0, unclear: 1 },
      by_type: { tone: 2, wrong_or_missing_fact: 1, other: 1 },
      pending: 3,
      accepted: 1,
      dismissed: 1,
      low_confidence: 3,
    });
  });

  it("prefers a non-dismissed suggestion over a newer dismissed one", () => {
    const rows = [
      suggestion({ id: "old", status: "pending", createdAt: "2026-10-23T09:00:00.000Z" }),
      suggestion({ id: "new", source: "judge", status: "dismissed", createdAt: "2026-10-23T12:00:00.000Z" }),
    ];
    expect(representatives(rows).map((r) => r.id)).toEqual(["old"]);
  });
});

describe("triage state", () => {
  it("lists failed graders with definitions and passing grader ids", () => {
    const built = buildTriageState({
      targetKind: "stage",
      caseRow: { evalRunId: "er_1", caseId: "c1", position: 0, case: { id: "c1", title: "T", input: { a: 1 }, expected: { b: 2 } } },
      result: result(),
      graderDefinitions: [
        { id: "verdict-ok", type: "field" },
        { id: "polite", type: "rubric", rubric: "Be polite", weight: 2, must_pass: true },
      ],
    });
    const state = JSON.parse(built.state);
    expect(state.failed_graders).toEqual([
      expect.objectContaining({ id: "polite", reason: "Too curt", weight: 2, must_pass: true, definition: { type: "rubric", rubric: "Be polite", weight: 2, must_pass: true } }),
    ]);
    expect(state.passed_graders).toEqual(["verdict-ok"]);
    expect(built.graderQuestions).toEqual([{ graderId: "polite", type: "rubric" }]);
    expect(built.truncated).toBe(false);
  });

  it("caps the state at 24,000 characters, records truncation and redacts secrets", () => {
    const huge = "x".repeat(200_000);
    const built = buildTriageState({
      targetKind: "stage",
      caseRow: { evalRunId: "er_1", caseId: "c1", position: 0, case: { id: "c1", input: huge, expected: huge } },
      result: result({
        errorMessage: `failed with sk-abcdefghijklmnopqrstuvwxyz0123456789 ${huge}`,
        output: { kind: "envelope", status: "success", summary: "s", payload: { blob: huge }, artifacts: [] },
      }),
      graderDefinitions: [{ id: "polite", type: "rubric", rubric: huge }],
    });
    expect(built.state.length).toBeLessThanOrEqual(24_000 + 20);
    expect(built.truncated).toBe(true);
    expect(JSON.parse(built.state).truncated_fields.length).toBeGreaterThan(0);
    expect(built.state).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("renders a conversation output as a transcript", () => {
    const built = buildTriageState({
      targetKind: "agent",
      caseRow: undefined,
      result: result({
        output: {
          kind: "conversation",
          status: "success",
          summary: "",
          messages: [{ turn: 1, role: "user", text: "hi" }, { turn: 1, role: "assistant", text: "hello" }],
          tool_calls: [],
          final_reply: "hello",
          turns: 1,
          stop_reason: "completed",
        },
      }),
      graderDefinitions: [],
    });
    const state = JSON.parse(built.state);
    expect(state.output.transcript).toContain("[turn 1] USER: hi");
    expect(state.output.transcript).toContain("AGENT: hello");
  });
});

describe("JevClassifier against a local System One fixture", () => {
  it("posts the System One shape with a Bearer key and maps the answers", async () => {
    const f = await fixture();
    const jev = createJevClassifier({ apiKey: "tsk-secret-value", baseUrl: f.baseUrl });
    const out = await jev.classify({
      targetKind: "agent",
      state: "FALSE_ALARM state",
      graderQuestions: [{ graderId: "polite", type: "rubric" }],
    });
    expect(f.requests).toHaveLength(1);
    const [req] = f.requests;
    expect(req.authorization).toBe("Bearer tsk-secret-value");
    expect(req.body.model).toBe(JEV_MODEL_ID);
    expect(Object.keys(req.body.questions)).toEqual(["bucket", "failure_type", "false_alarm_0"]);
    expect(Object.keys(req.body.questions.bucket.criteria ?? {})).toEqual(["agent_wrong", "grader_wrong", "case_wrong", "unclear"]);
    expect(req.body.questions.false_alarm_0.type).toBe("noul");
    expect(req.body.questions.false_alarm_0.instructions).toContain("polite");
    expect(out.bucket).toBe("grader_wrong");
    expect(out.confidence).toBeCloseTo(0.91, 5);
    expect(out.failureType).toBe("missing_tool_call");
    expect(out.graderFalseAlarms).toEqual([{ graderId: "polite", probability: 0.8 }]);
    expect(out.answeredModel).toBe(JEV_MODEL_ID);
    expect(out.costUsd).toBeCloseTo(0.042, 6);
  });

  it("sends stage failure types for stage targets", async () => {
    const f = await fixture();
    const jev = createJevClassifier({ apiKey: "k", baseUrl: f.baseUrl });
    await jev.classify({ targetKind: "stage", state: "s", graderQuestions: [] });
    expect(Object.keys(f.requests[0].body.questions.failure_type.criteria ?? {})).toContain("wrong_value");
  });

  it("retries 429 with backoff and then succeeds", async () => {
    const f = await fixture();
    f.queue.push({ status: 429, headers: { "retry-after": "2" } }, { status: 429 });
    const waits: number[] = [];
    const jev = createJevClassifier({ apiKey: "k", baseUrl: f.baseUrl, backoffBaseMs: 100, sleep: async (ms) => void waits.push(ms) });
    const out = await jev.classify({ targetKind: "stage", state: "s", graderQuestions: [] });
    expect(out.bucket).toBe("agent_wrong");
    expect(f.requests).toHaveLength(3);
    expect(waits).toEqual([2000, 200]);
  });

  it("gives up after the retry limit with a code, never the key", async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) f.queue.push({ status: 429 });
    const jev = createJevClassifier({ apiKey: "tsk-never-leak", baseUrl: f.baseUrl, maxRetries: 2, sleep: async () => undefined });
    const error = await jev.classify({ targetKind: "stage", state: "s", graderQuestions: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClassifierError);
    expect((error as ClassifierError).code).toBe("CLASSIFIER_RATE_LIMITED");
    expect(String((error as Error).message)).not.toContain("tsk-never-leak");
    expect(f.requests).toHaveLength(3);
  });

  it("maps 422 and 500 to errors without echoing the response body", async () => {
    const f = await fixture();
    f.queue.push({ status: 422, body: { detail: "secret detail tsk-body" } }, { status: 500, body: { detail: "boom tsk-body" } });
    const jev = createJevClassifier({ apiKey: "k", baseUrl: f.baseUrl });
    const a = (await jev.classify({ targetKind: "stage", state: "s", graderQuestions: [] }).catch((e: unknown) => e)) as ClassifierError;
    const b = (await jev.classify({ targetKind: "stage", state: "s", graderQuestions: [] }).catch((e: unknown) => e)) as ClassifierError;
    expect(a.code).toBe("CLASSIFIER_REJECTED");
    expect(b.code).toBe("CLASSIFIER_FAILED");
    expect(a.message + b.message).not.toContain("tsk-body");
  });

  it("rejects a reply with no valid bucket and accepts the explicit unclear choice", async () => {
    const f = await fixture();
    f.queue.push({ status: 200, body: { model: JEV_MODEL_ID, answers: { bucket: { choice: "banana" } }, usage: { input_tokens: 1 } } });
    const jev = createJevClassifier({ apiKey: "k", baseUrl: f.baseUrl });
    const bad = (await jev.classify({ targetKind: "stage", state: "s", graderQuestions: [] }).catch((e: unknown) => e)) as ClassifierError;
    expect(bad.code).toBe("CLASSIFIER_BAD_REPLY");
    const unclear = await jev.classify({ targetKind: "stage", state: "UNSURE", graderQuestions: [] });
    expect(unclear.bucket).toBe("unclear");
    expect(unclear.confidence).toBeCloseTo(0.4, 5);
  });
});

describe("JudgeClassifier", () => {
  it("parses a JSON reply and filters unknown graders", async () => {
    const model = new FakeSimulatorModel([
      {
        text: 'Here you go: {"bucket":"case_wrong","confidence":0.82,"failure_type":"wrong_value","grader_false_alarms":[{"grader_id":"polite","probability":0.3},{"grader_id":"ghost","probability":0.9}]}',
        usage: { costUsd: 0.002, tokensIn: 10, tokensOut: 5, model: "anthropic/judge" },
      },
    ]);
    const judge = createJudgeClassifier({ model, modelId: "anthropic/judge" });
    const out = await judge.classify({ targetKind: "stage", state: "{}", graderQuestions: [{ graderId: "polite", type: "rubric" }] });
    expect(out).toMatchObject({ bucket: "case_wrong", confidence: 0.82, failureType: "wrong_value", costUsd: 0.002 });
    expect(out.graderFalseAlarms).toEqual([{ graderId: "polite", probability: 0.3 }]);
    expect(model.calls[0].user).toContain("<state>");
    expect(model.calls[0].system).toContain("grader_wrong");
  });

  it("fails with a code when the reply is not valid", async () => {
    const judge = createJudgeClassifier({ model: new FakeSimulatorModel(["no json here"]), modelId: "a/b" });
    const error = (await judge.classify({ targetKind: "stage", state: "{}", graderQuestions: [] }).catch((e: unknown) => e)) as ClassifierError;
    expect(error.code).toBe("CLASSIFIER_BAD_REPLY");
  });
});

describe("TypeSafe key lookup", () => {
  it("tries the stored credential, then the env names in order; reports names only", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-triage-key-"));
    tmps.push(home);
    const project = path.join(home, "project");
    await mkdir(project, { recursive: true });
    const none = resolveTypesafeKey(project, {});
    expect(none).toEqual({ key: undefined, sources: [] });
    const env = { JEV_API_KEY: "jev-key", TYPESAFE_API_KEY: "ts-key", STAGEFLOW_PROVIDER_TYPESAFE_API_KEY: "sf-key" };
    expect(resolveTypesafeKey(project, env)).toEqual({
      key: "sf-key",
      sources: ["STAGEFLOW_PROVIDER_TYPESAFE_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY"],
    });
    expect(resolveTypesafeKey(project, { TYPESAFE_API_KEY: "ts-key", JEV_API_KEY: "jev-key" }).key).toBe("ts-key");
    expect(resolveTypesafeKey(project, { JEV_API_KEY: "jev-key" }).key).toBe("jev-key");
    await writeFile(path.join(home, "unused"), "");
  });
});
