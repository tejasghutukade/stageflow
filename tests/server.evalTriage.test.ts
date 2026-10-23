import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRunManager } from "../src/evals/manager.js";
import { FakeSimulatorModel } from "../src/evals/runner/simulatorModel.js";
import { JEV_MODEL_ID } from "../src/evals/triage/constants.js";
import type { TriageDeps } from "../src/evals/triage/service.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../src/server/evalRoutes.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";
import { startSystemOneFixture, type SystemOneFixture } from "./helpers/systemOneFixture.js";

const SECRET_KEY = "tsk-super-secret-key-1234567890";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Api = { status: number; body: any; text: string };

type Harness = {
  store: RunStore;
  projectRoot: string;
  fixture: SystemOneFixture;
  runId: string;
  activeRunId: string;
  triage: { current: Omit<TriageDeps, "store"> };
  call: (method: string, urlPath: string, body?: unknown) => Promise<Api>;
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const GRADER_DEFS = [
  { id: "verdict-ok", type: "field", checks: [] },
  { id: "polite", type: "rubric", rubric: "Be polite", weight: 1 },
];

function grades(passed: boolean) {
  return [
    { graderId: "verdict-ok", graderType: "field", status: "graded" as const, passed: true, score: 1 },
    { graderId: "polite", graderType: "rubric", status: "graded" as const, passed, score: passed ? 1 : 0, reason: passed ? "fine" : "Too curt" },
  ];
}

async function setup(options: { judge?: string | null } = {}): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-eval-triage-"));
  bindStageflowHomeForTests(home);
  const store = createRunStore({ rootDir: home });
  const fixture = await startSystemOneFixture();
  const projectRoot = await store.ensureProject(await mkdtemp(path.join(tmpdir(), "sf-eval-triage-proj-")));
  const base = {
    evalId: "review",
    evalPath: "evals/review.eval.yaml",
    evalHash: "h",
    targetKind: "stage" as const,
    targetRef: { pipeline_path: "p.yaml", stage_id: "review" },
    targetVersionHash: "h",
    datasetPath: "d.jsonl",
    datasetHash: "h",
    config: {
      settings: options.judge === null ? {} : { judge: options.judge ?? "anthropic/judge-model" },
      eval: { definition: { graders: GRADER_DEFS } },
    },
    configFingerprint: "f",
    configComponents: {},
    repeats: 1,
    passThreshold: 0.8,
    maxCostUsd: 1,
    casesTotal: 4,
    resultsTotal: 4,
    engineName: "fake",
    engineVersion: "1",
    stageflowVersion: "1",
    startedVia: "cli" as const,
  };
  const run = await store.createEvalRun({ ...base, projectRoot });
  const active = await store.createEvalRun({ ...base, projectRoot, status: "running" });
  await store.insertEvalCases(
    run.evalRunId,
    ["c1", "c2", "c3", "c4"].map((id, position) => ({ caseId: id, position, case: { id, title: `Case ${id}`, input: { q: id } } })),
  );
  const out = (summary: string) => ({ kind: "envelope", status: "success", summary, payload: {}, artifacts: [] });
  await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "c1", repeatIndex: 0, status: "completed", passed: false, output: out("FALSE_ALARM fine"), grades: grades(false) });
  await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "c2", repeatIndex: 0, status: "completed", passed: false, output: out("bad"), grades: grades(false) });
  await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "c3", repeatIndex: 0, status: "completed", passed: true, output: out("good"), grades: grades(true) });
  await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "c4", repeatIndex: 0, status: "error", errorCode: "EVAL_ENGINE_ERROR", errorMessage: "UNSURE what happened", passed: false });
  await store.finishEvalRun(run.evalRunId, { status: "completed", passed: false, summary: {}, finishedAt: new Date().toISOString() });

  const triage: { current: Omit<TriageDeps, "store"> } = {
    current: {
      resolveKey: () => ({ key: SECRET_KEY, sources: ["JEV_API_KEY"] }),
      jevBaseUrl: fixture.baseUrl,
      sleep: async () => undefined,
    },
  };
  const deps = {
    cwd: "/p/one",
    store,
    manager: {} as unknown as RunManager,
    evalRunManager: {} as unknown as EvalRunManager,
    json,
    readJsonBody: readBody,
    auditLog: { info: () => undefined } as unknown as EvalRoutesDeps["auditLog"],
    engineStatus: () => {
      throw new Error("not used");
    },
    get triage() {
      return triage.current;
    },
  } as EvalRoutesDeps;
  const server: Server = createServer((req, res) => {
    handleEvalRoutes(req, res, deps).then(
      (handled) => {
        if (!handled) json(res, 404, { error: "Not found" });
      },
      () => json(res, 500, { error: "unhandled" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = async (method: string, urlPath: string, body?: unknown): Promise<Api> => {
    const res = await fetch(`${origin}${urlPath}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {}, text };
  };
  return { store, projectRoot, fixture, runId: run.evalRunId, activeRunId: active.evalRunId, triage, call };
}

const sortPath = (h: Harness, run = h.runId): string => `/api/eval-runs/${run}/failures/sort`;
const listPath = (h: Harness): string => `/api/eval-runs/${h.runId}/failures/suggestions`;

describe("failure sorting routes", () => {
  it("reports classifier status without exposing a key", async () => {
    const h = await setup();
    const res = await h.call("GET", `/api/eval-runs/${h.runId}/failures/status`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      classifiers: {
        jev: { available: true, model: JEV_MODEL_ID, key_sources: ["JEV_API_KEY"] },
        judge: { available: false, model: "anthropic/judge-model", reason: expect.any(String) },
      },
      default: "jev",
    });
    expect(res.text).not.toContain(SECRET_KEY);
  });

  it("sorts failed and errored results with jev, never passed ones, and costs by input tokens", async () => {
    const h = await setup();
    const res = await h.call("POST", sortPath(h), {});
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SECRET_KEY);
    expect(res.body).toMatchObject({ classifier: "jev", model: JEV_MODEL_ID, sorted: 3, skipped: 0, failed: 0 });
    expect(res.body.batch_id).toMatch(/^sb_/);
    expect(res.body.triage_cost_usd).toBeCloseTo(3 * 0.042, 6);
    const byCase = Object.fromEntries(res.body.suggestions.map((s: any) => [s.case_id, s]));
    expect(Object.keys(byCase).sort()).toEqual(["c1", "c2", "c4"]);
    expect(byCase.c1).toMatchObject({
      repeat_index: 0, source: "jev", bucket: "grader_wrong", failure_type: "wrong_value", status: "pending", model: JEV_MODEL_ID, prompt_version: 1,
      grader_false_alarms: [{ grader_id: "polite", probability: 0.8 }],
    });
    expect(byCase.c1.confidence).toBeCloseTo(0.91, 5);
    expect(byCase.c1.bucket_probabilities.grader_wrong).toBeCloseTo(0.91, 5);
    expect(byCase.c2).toMatchObject({ bucket: "agent_wrong" });
    expect(byCase.c4).toMatchObject({ bucket: "unclear" });
    expect(h.fixture.requests).toHaveLength(3);
    for (const r of h.fixture.requests) expect(r.authorization).toBe(`Bearer ${SECRET_KEY}`);
    const c1State = JSON.parse(h.fixture.requests.find((r) => r.body.state.includes("FALSE_ALARM"))!.body.state);
    expect(c1State.failed_graders.map((g: any) => g.id)).toEqual(["polite"]);
    expect(c1State.passed_graders).toEqual(["verdict-ok"]);
  });

  it("skips already sorted results unless only_unsorted is false, which replaces pending ones", async () => {
    const h = await setup();
    await h.call("POST", sortPath(h), {});
    const again = await h.call("POST", sortPath(h), {});
    expect(again.body).toMatchObject({ sorted: 0, skipped: 3 });
    const resort = await h.call("POST", sortPath(h), { only_unsorted: false });
    expect(resort.body).toMatchObject({ sorted: 3, skipped: 0 });
    expect((await h.call("GET", listPath(h))).body.items).toHaveLength(3);
  });

  it("honors limit", async () => {
    const h = await setup();
    const res = await h.call("POST", sortPath(h), { limit: 2 });
    expect(res.body).toMatchObject({ sorted: 2, skipped: 1 });
  });

  it("lists suggestions with a server-computed summary and filters by status", async () => {
    const h = await setup();
    await h.call("POST", sortPath(h), {});
    const res = await h.call("GET", listPath(h));
    expect(res.body.summary).toEqual({
      by_bucket: { agent_wrong: 1, grader_wrong: 1, case_wrong: 0, unclear: 1 },
      by_type: { wrong_value: 3 },
      pending: 3,
      accepted: 0,
      dismissed: 0,
      low_confidence: 1,
    });
    expect((await h.call("GET", `${listPath(h)}?status=accepted`)).body.items).toEqual([]);
    expect((await h.call("GET", `${listPath(h)}?status=nope`)).status).toBe(400);
  });

  it("puts the suggestion on the result detail repeats", async () => {
    const h = await setup();
    const before = await h.call("GET", `/api/eval-runs/${h.runId}/results/c1`);
    expect(before.body.repeats[0].suggestion).toBeNull();
    await h.call("POST", sortPath(h), {});
    const after = await h.call("GET", `/api/eval-runs/${h.runId}/results/c1`);
    expect(after.body.repeats[0].suggestion).toMatchObject({ case_id: "c1", bucket: "grader_wrong", source: "jev", status: "pending" });
    const passed = await h.call("GET", `/api/eval-runs/${h.runId}/results/c3`);
    expect(passed.body.repeats[0].suggestion).toBeNull();
  });

  it("accepts by id as failure type and bucket tags, keeping tags already there", async () => {
    const h = await setup();
    const sorted = await h.call("POST", sortPath(h), {});
    const c2 = sorted.body.suggestions.find((s: any) => s.case_id === "c2");
    await h.store.putEvalReview(h.runId, "c2", 0, { tags: ["mine"] });
    const res = await h.call("POST", `${listPath(h)}/accept`, { ids: [c2.id] });
    expect(res.body).toEqual({ accepted: 1, tagged: 1 });
    const detail = await h.call("GET", `/api/eval-runs/${h.runId}/results/c2`);
    expect(detail.body.repeats[0].tags).toEqual(["mine", "wrong_value", "bucket:agent_wrong"]);
    expect(detail.body.repeats[0].suggestion.status).toBe("accepted");
    expect(await h.store.listFailureTypes(h.projectRoot, "review")).toEqual(expect.arrayContaining(["wrong_value", "bucket:agent_wrong"]));
    const again = await h.call("POST", `${listPath(h)}/accept`, { ids: [c2.id] });
    expect(again.body).toEqual({ accepted: 0, tagged: 0 });
  });

  it("bulk accepts only confident, non-unclear suggestions and can filter by bucket", async () => {
    const h = await setup();
    await h.call("POST", sortPath(h), {});
    const bucketOnly = await h.call("POST", `${listPath(h)}/accept`, { bucket: "agent_wrong" });
    expect(bucketOnly.body).toEqual({ accepted: 1, tagged: 1 });
    const rest = await h.call("POST", `${listPath(h)}/accept`, {});
    expect(rest.body).toEqual({ accepted: 1, tagged: 1 });
    const summary = (await h.call("GET", listPath(h))).body.summary;
    expect(summary).toMatchObject({ accepted: 2, pending: 1 });
    const c4 = await h.call("GET", `/api/eval-runs/${h.runId}/results/c4`);
    expect(c4.body.repeats[0].tags).toEqual([]);
    expect((await h.call("POST", `${listPath(h)}/accept`, { min_confidence: 2 })).status).toBe(400);
  });

  it("dismisses and keeps accepted and dismissed ones across a re-sort", async () => {
    const h = await setup();
    const sorted = await h.call("POST", sortPath(h), {});
    const [c1, c2] = ["c1", "c2"].map((id) => sorted.body.suggestions.find((s: any) => s.case_id === id));
    expect((await h.call("POST", `${listPath(h)}/dismiss`, { ids: [c1.id] })).body).toEqual({ dismissed: 1 });
    await h.call("POST", `${listPath(h)}/accept`, { ids: [c2.id] });
    const resort = await h.call("POST", sortPath(h), { only_unsorted: false });
    expect(resort.body).toMatchObject({ sorted: 1, skipped: 2 });
    const items = (await h.call("GET", listPath(h))).body.items;
    expect(items.find((s: any) => s.case_id === "c1").status).toBe("dismissed");
    expect(items.find((s: any) => s.case_id === "c2").status).toBe("accepted");
    expect((await h.call("POST", `${listPath(h)}/dismiss`, {})).status).toBe(400);
  });

  it("refuses a run that is still running", async () => {
    const h = await setup();
    const res = await h.call("POST", sortPath(h, h.activeRunId), {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVAL_RUN_ACTIVE");
  });

  it("returns 404 for an unknown run and 400 for a bad body", async () => {
    const h = await setup();
    expect((await h.call("POST", "/api/eval-runs/er_nope/failures/sort", {})).body.code).toBe("EVAL_RUN_NOT_FOUND");
    expect((await h.call("POST", sortPath(h), { classifier: "other" })).status).toBe(400);
    expect((await h.call("POST", sortPath(h), { limit: 0 })).status).toBe(400);
  });

  it("answers 422 EVAL_CLASSIFIER_UNAVAILABLE naming what is missing", async () => {
    const h = await setup({ judge: null });
    h.triage.current = { ...h.triage.current, resolveKey: () => ({ key: undefined, sources: [] }) };
    const auto = await h.call("POST", sortPath(h), {});
    expect(auto.status).toBe(422);
    expect(auto.body).toMatchObject({ code: "EVAL_CLASSIFIER_UNAVAILABLE", missing: "typesafe_key" });
    expect(auto.body.error).toContain("STAGEFLOW_PROVIDER_TYPESAFE_API_KEY");
    const judge = await h.call("POST", sortPath(h), { classifier: "judge" });
    expect(judge.body).toMatchObject({ code: "EVAL_CLASSIFIER_UNAVAILABLE", missing: "judge_model" });
    const status = await h.call("GET", `/api/eval-runs/${h.runId}/failures/status`);
    expect(status.body.default).toBeNull();
  });

  it("falls back to the judge classifier when there is no key", async () => {
    const h = await setup();
    const model = new FakeSimulatorModel(() => ({
      text: '{"bucket":"agent_wrong","confidence":0.88,"failure_type":"tone","grader_false_alarms":[{"grader_id":"polite","probability":0.1}]}',
      usage: { costUsd: 0.003, tokensIn: 5, tokensOut: 5, model: "anthropic/judge-model" },
    }));
    h.triage.current = {
      resolveKey: () => ({ key: undefined, sources: [] }),
      judgeModel: () => model,
    };
    const res = await h.call("POST", sortPath(h), {});
    expect(res.body).toMatchObject({ classifier: "judge", model: "anthropic/judge-model", sorted: 3, failed: 0 });
    expect(res.body.triage_cost_usd).toBeCloseTo(0.009, 6);
    expect(res.body.suggestions[0]).toMatchObject({ source: "judge", bucket: "agent_wrong", failure_type: "tone" });
    expect(h.fixture.requests).toHaveLength(0);
  });

  it("counts classifier failures without writing suggestions", async () => {
    const h = await setup();
    h.fixture.queue.push({ status: 500 }, { status: 422 });
    const res = await h.call("POST", sortPath(h), {});
    expect(res.body).toMatchObject({ sorted: 1, failed: 2 });
    expect(res.text).not.toContain(SECRET_KEY);
  });
});
