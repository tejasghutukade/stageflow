import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunTokenRegistry } from "../src/evals/engine/promptfoo/runTokens.js";
import type { RunCaseResult } from "../src/evals/types.js";
import { resolveAllowedHosts } from "../src/server/allowedHosts.js";
import { loadControlTokens, requiredScopeFor } from "../src/server/controlToken.js";
import { json } from "../src/server/createHttpHost.js";
import { EVAL_INTERNAL_RUN_CASE_PATH, type EvalInternalServices } from "../src/server/evalInternalRoutes.js";
import { createOperatorRoutes } from "../src/server/http.js";
import type { RunManager } from "../src/runtime/runManager.js";
import type { RunStore } from "../src/runstore/port.js";
import { okRun, samplePlan } from "./evals/promptfooHelpers.js";

const DRIVE = "d".repeat(32);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function start(evalServices: Parameters<typeof createOperatorRoutes>[0]["evalServices"]) {
  const manager = {
    onGateClosed: () => () => undefined,
    beforeBrowserTeardown: () => () => undefined,
    onShutdown: () => () => undefined,
  } as unknown as RunManager;
  const routes = createOperatorRoutes({
    manager,
    store: {} as unknown as RunStore,
    cwd: process.cwd(),
    agentDir: process.cwd(),
    rootDir: process.cwd(),
    providerAuthContext: undefined,
    allowedHosts: resolveAllowedHosts({}),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    ...(evalServices !== undefined ? { evalServices } : {}),
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await routes({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      json,
      boot: {} as never,
    });
    if (!handled) json(res, 404, { error: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return async (bearer: string | undefined, body: unknown, method = "POST") => {
    const res = await fetch(`${origin}${EVAL_INTERNAL_RUN_CASE_PATH}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
}

const request = { eval_run_id: "run-1", case_id: "c1", repeat_index: 1 };

function fixture(running = true) {
  const tokens = new RunTokenRegistry();
  const calls: Array<{ via: string; caseId: string; repeatIndex: number }> = [];
  const services: EvalInternalServices = {
    tokens,
    runner: {
      runCase: async (_plan, req) => {
        calls.push({ via: "runner", caseId: req.caseId, repeatIndex: req.repeatIndex });
        return okRun(req.caseId, req.repeatIndex);
      },
    },
    isRunning: (id) => running && id === "run-1",
  };
  return { tokens, calls, services };
}

describe("POST /api/evals/internal/run-case", () => {
  it("answers 404 while no eval services are wired, even with the control token", async () => {
    const post = await start(undefined);
    expect((await post(DRIVE, request)).status).toBe(404);
    expect((await post(undefined, request)).status).toBe(404);
  });

  it("resolves its services lazily", async () => {
    const { tokens, services } = fixture();
    let wired: EvalInternalServices | undefined;
    const post = await start(() => wired);
    const token = tokens.issue("run-1", { plan: samplePlan() });
    expect((await post(token, request)).status).toBe(404);
    wired = services;
    expect((await post(token, request)).status).toBe(200);
  });

  it("rejects missing, unknown and control tokens with 401", async () => {
    const { tokens, services } = fixture();
    tokens.issue("run-1", { plan: samplePlan() });
    const post = await start(services);
    expect((await post(undefined, request)).status).toBe(401);
    expect((await post("nope", request)).status).toBe(401);
    expect((await post(DRIVE, request)).status).toBe(401);
  });

  it("accepts the issued token and returns the RunCaseResult from the runner", async () => {
    const { tokens, services, calls } = fixture();
    const token = tokens.issue("run-1", { plan: samplePlan() });
    const post = await start(services);
    const res = await post(token, request);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(okRun("c1", 1))));
    expect(calls).toEqual([{ via: "runner", caseId: "c1", repeatIndex: 1 }]);
    expect(res.text).not.toContain(token);
  });

  it("prefers the handler the engine registered", async () => {
    const { tokens, services, calls } = fixture();
    const failure: RunCaseResult = { ok: false, code: "EVAL_STAGE_FAILED", message: "boom" };
    const token = tokens.issue("run-1", { plan: samplePlan(), runCase: async () => failure });
    const post = await start(services);
    expect((await post(token, request)).body).toEqual(failure);
    expect(calls).toEqual([]);
  });

  it("rejects a token used for another run", async () => {
    const { tokens, services } = fixture();
    const token = tokens.issue("run-1", { plan: samplePlan() });
    const post = await start(services);
    expect((await post(token, { ...request, eval_run_id: "run-2" })).status).toBe(401);
  });

  it("rejects when the run is not running", async () => {
    const { tokens, services } = fixture(false);
    const token = tokens.issue("run-1", { plan: samplePlan() });
    const post = await start(services);
    expect((await post(token, request)).status).toBe(409);
  });

  it("never accepts a token after it is revoked or replaced", async () => {
    const { tokens, services } = fixture();
    const first = tokens.issue("run-1", { plan: samplePlan() });
    const post = await start(services);
    expect((await post(first, request)).status).toBe(200);
    const second = tokens.issue("run-1", { plan: samplePlan() });
    expect((await post(first, request)).status).toBe(401);
    expect((await post(second, request)).status).toBe(200);
    tokens.revoke("run-1");
    expect((await post(second, request)).status).toBe(401);
  });

  it("validates the body and the method", async () => {
    const { tokens, services } = fixture();
    const token = tokens.issue("run-1", { plan: samplePlan() });
    const post = await start(services);
    expect((await post(token, "not json")).status).toBe(400);
    expect((await post(token, { ...request, repeat_index: -1 })).status).toBe(400);
    expect((await post(token, { ...request, case_id: 4 })).status).toBe(400);
    expect((await post(token, request, "GET")).status).toBe(404);
  });

  it("does not use the control token scope and is not documented", () => {
    expect(requiredScopeFor("POST", EVAL_INTERNAL_RUN_CASE_PATH)).toBeNull();
    const docs = path.resolve("docs");
    const texts = readdirSync(docs, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          !/[\\/](specs|tickets|ideation|plans)([\\/]|$)/.test(entry.parentPath),
      )
      .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
    expect(texts.some((text) => text.includes("evals/internal"))).toBe(false);
  });
});

describe("RunTokenRegistry", () => {
  it("issues distinct random tokens and forgets revoked ones", () => {
    const registry = new RunTokenRegistry();
    const a = registry.issue("r1");
    const b = registry.issue("r2");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(registry.verify(a)?.evalRunId).toBe("r1");
    registry.revoke("r1");
    expect(registry.verify(a)).toBeUndefined();
    expect(registry.has("r2")).toBe(true);
    expect(registry.verify(undefined)).toBeUndefined();
    expect(registry.verify("")).toBeUndefined();
  });
});
