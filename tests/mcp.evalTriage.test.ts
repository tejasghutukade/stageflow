import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRunManager } from "../src/evals/manager.js";
import { handleMcpHttpRequest } from "../src/mcp/server.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { TOOL_META } from "../src/toolkit/meta.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { startSystemOneFixture } from "./helpers/systemOneFixture.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const KEY = "tsk-mcp-secret-key-123456";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(hasKey = true) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-triage-"));
  bindStageflowHomeForTests(home);
  const store = createRunStore({ rootDir: home });
  const fixture = await startSystemOneFixture();
  const projectRoot = await store.ensureProject(await mkdtemp(path.join(tmpdir(), "sf-mcp-triage-proj-")));
  const run = await store.createEvalRun({
    projectRoot,
    evalId: "review",
    evalPath: "evals/review.eval.yaml",
    evalHash: "h",
    targetKind: "stage",
    targetRef: { stage_id: "review" },
    targetVersionHash: "h",
    datasetPath: "d.jsonl",
    datasetHash: "h",
    config: { settings: {}, eval: { definition: { graders: [{ id: "g", type: "code", code: "return true" }] } } },
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
    startedVia: "mcp",
  });
  await store.insertEvalCases(run.evalRunId, [{ caseId: "c1", position: 0, case: { id: "c1", input: {} } }]);
  await store.upsertEvalResult({
    evalRunId: run.evalRunId,
    caseId: "c1",
    repeatIndex: 0,
    status: "completed",
    passed: false,
    output: { kind: "envelope", status: "success", summary: "bad", payload: {}, artifacts: [] },
    grades: [{ graderId: "g", graderType: "code", status: "graded", passed: false, reason: "no" }],
  });
  await store.finishEvalRun(run.evalRunId, { status: "completed", passed: false, summary: {}, finishedAt: new Date().toISOString() });
  const mcpDeps = {
    manager: {} as unknown as RunManager,
    store,
    cwd: projectRoot,
    evalRunManager: {} as unknown as EvalRunManager,
    triage: {
      resolveKey: () => ({ key: hasKey ? KEY : undefined, sources: hasKey ? ["JEV_API_KEY"] : [] }),
      jevBaseUrl: fixture.baseUrl,
      sleep: async () => undefined,
    },
  };
  const server: Server = createServer((req, res) => {
    void handleMcpHttpRequest(req, res, mcpDeps);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  });
  return { base, runId: run.evalRunId, fixture, tool: (name: string, args: Record<string, unknown>) => mcpCall(base, name, args) };
}

describe("MCP failure sorting tools", () => {
  it("lists the tools with a cost and privacy note on the sort action", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    const tools = data.result.tools as Array<{ name: string; description: string }>;
    const names = tools.map((t) => t.name);
    for (const name of ["sort_eval_failures", "get_eval_failure_suggestions", "get_eval_failure_sort_status"]) {
      expect(names).toContain(name);
    }
    const sort = tools.find((t) => t.name === "sort_eval_failures")!;
    expect(sort.description).toMatch(/external classifier/i);
    expect(sort.description).toMatch(/manual only/i);
    expect(sort.description).toMatch(/\$0\.04/);
    expect(TOOL_META.sort_eval_failures).toMatchObject({ group: "evals.run", risk: "external" });
    expect(TOOL_META.get_eval_failure_suggestions).toMatchObject({ group: "evals.read", risk: "read" });
  });

  it("sorts, then reads suggestions and status; the key never appears", async () => {
    const h = await setup();
    const sorted = await h.tool("sort_eval_failures", { eval_run_id: h.runId });
    expect(sorted.isError).toBe(false);
    expect(sorted.payload).toMatchObject({ classifier: "jev", sorted: 1, failed: 0 });
    const list = await h.tool("get_eval_failure_suggestions", { eval_run_id: h.runId, status: "pending" });
    expect(list.payload.items).toHaveLength(1);
    expect(list.payload.summary).toMatchObject({ pending: 1, by_bucket: { agent_wrong: 1 } });
    const status = await h.tool("get_eval_failure_sort_status", { eval_run_id: h.runId });
    expect(status.payload).toMatchObject({ default: "jev", classifiers: { jev: { available: true, key_sources: ["JEV_API_KEY"] } } });
    for (const res of [sorted, list, status]) expect(JSON.stringify(res.raw)).not.toContain(KEY);
  });

  it("returns an error result when no classifier is available", async () => {
    const h = await setup(false);
    const res = await h.tool("sort_eval_failures", { eval_run_id: h.runId });
    expect(res.isError).toBe(true);
    expect(res.payload).toMatchObject({ code: "EVAL_CLASSIFIER_UNAVAILABLE", missing: "typesafe_key" });
  });
});
