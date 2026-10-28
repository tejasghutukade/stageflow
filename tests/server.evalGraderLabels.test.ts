import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRunManager } from "../src/evals/manager.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../src/server/evalRoutes.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-eval-labels-"));
  bindStageflowHomeForTests(home);
  const store = createRunStore({ rootDir: home });
  const projectRoot = await store.ensureProject(await mkdtemp(path.join(tmpdir(), "sf-eval-labels-proj-")));
  const run = await store.createEvalRun({
    projectRoot,
    evalId: "review",
    evalPath: "evals/review.eval.yaml",
    evalHash: "h",
    targetKind: "stage",
    targetRef: { pipeline_path: "p.yaml", stage_id: "review" },
    targetVersionHash: "h",
    datasetPath: "d.jsonl",
    datasetHash: "h",
    config: { settings: {}, eval: { definition: { graders: [] } } },
    configFingerprint: "f",
    configComponents: {},
    repeats: 1,
    passThreshold: 0.8,
    maxCostUsd: 1,
    casesTotal: 1,
    resultsTotal: 1,
    engineName: "fake",
    engineVersion: "1",
    stageflowVersion: "1",
    startedVia: "cli",
  });
  await store.insertEvalCases(run.evalRunId, [{ caseId: "c1", position: 0, case: { id: "c1", input: { q: 1 } } }]);
  await store.upsertEvalResult({
    evalRunId: run.evalRunId,
    caseId: "c1",
    repeatIndex: 0,
    status: "completed",
    passed: true,
    output: { kind: "envelope", status: "success", summary: "ok", payload: {}, artifacts: [] },
    grades: [
      { graderId: "polite", graderType: "rubric", status: "graded", passed: true, score: 1 },
      { graderId: "shape", graderType: "field", status: "graded", passed: true, score: 1 },
    ],
  });
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
    await rm(home, { recursive: true, force: true });
  });
  const call = async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(`${origin}${urlPath}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  return { store, runId: run.evalRunId, call };
}

describe("grader label routes", () => {
  it("sets, shows and clears a label on a judged grader", async () => {
    const h = await setup();
    const url = `/api/eval-runs/${h.runId}/results/c1/0/graders/polite/label`;
    const put = await h.call("PUT", url, { label: "fail", note: "curt" });
    expect(put).toEqual({ status: 200, body: { label: "fail", note: "curt" } });

    const detail = await h.call("GET", `/api/eval-runs/${h.runId}/results/c1`);
    expect(detail.body.repeats[0].grader_labels).toEqual({ polite: { label: "fail", note: "curt" } });

    const cleared = await h.call("PUT", url, { label: null });
    expect(cleared.body).toEqual({ label: null, note: null });
    const after = await h.call("GET", `/api/eval-runs/${h.runId}/results/c1`);
    expect(after.body.repeats[0].grader_labels).toEqual({});
  });

  it("rejects a non-judged grader, a bad label and a missing result", async () => {
    const h = await setup();
    const base = `/api/eval-runs/${h.runId}/results`;
    expect((await h.call("PUT", `${base}/c1/0/graders/shape/label`, { label: "pass" })).status).toBe(400);
    expect((await h.call("PUT", `${base}/c1/0/graders/polite/label`, { label: "maybe" })).status).toBe(400);
    expect((await h.call("PUT", `${base}/zz/0/graders/polite/label`, { label: "pass" })).status).toBe(404);
  });
});
