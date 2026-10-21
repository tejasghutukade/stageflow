import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../src/evals/engine/promptfoo/errors.js";
import { PromptfooEngine, type PromptfooEngineOptions } from "../src/evals/engine/promptfoo/PromptfooEngine.js";
import { RunTokenRegistry } from "../src/evals/engine/promptfoo/runTokens.js";
import type { EvalPlan, RunCaseResult } from "../src/evals/types.js";
import { json } from "../src/server/createHttpHost.js";
import { EVAL_INTERNAL_RUN_CASE_PATH, handleEvalInternalRoutes } from "../src/server/evalInternalRoutes.js";
import { okRun, recordingIo, samplePlan } from "./evals/promptfooHelpers.js";

const BIN = path.resolve("tests/fixtures/evals/fakePromptfoo.mjs");
const GRADER_URL = pathToFileURL(path.resolve("src/evals/graders/index.ts")).href;
const temps: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(extra: Partial<PromptfooEngineOptions> = {}, mode = "ok") {
  const home = mkdtempSync(path.join(tmpdir(), "sf-pf-engine-"));
  temps.push(home);
  const tokens = new RunTokenRegistry();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleEvalInternalRoutes(
      req,
      req.method ?? "GET",
      url.pathname,
      {
        tokens,
        runner: { runCase: async () => Promise.reject(new Error("engine handler expected")) },
        isRunning: () => true,
      },
      res,
      json,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const callbackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${EVAL_INTERNAL_RUN_CASE_PATH}`;
  const engine = new PromptfooEngine({
    tokens,
    callbackUrl,
    home,
    binPath: BIN,
    nodeVersion: "99.0.0",
    graderModuleUrl: GRADER_URL,
    resolveJudgeKey: () => "judge-key-value",
    loadJudgePrices: async () => new Map([["openai/stub-judge", { inputPerMillion: 3, outputPerMillion: 15 }]]),
    extraEnv: { FAKE_MODE: mode },
    streamPollMs: 20,
    ...extra,
  });
  return { engine, home, tokens };
}

function workDirOf(home: string, plan: EvalPlan): string {
  return path.join(home, "eval-runs", plan.evalRunId);
}

describe("PromptfooEngine with a fake promptfoo binary", () => {
  it("runs end to end: streams normalized results, reports judge cost, cleans up", async () => {
    const { engine, home, tokens } = await setup();
    const plan = samplePlan();
    const rec = recordingIo();
    await engine.run(plan, rec.io, new AbortController().signal);

    expect(rec.results.map((r) => `${r.caseId}#${r.repeatIndex}`).sort()).toEqual(["c1#0", "c1#1", "c2#0", "c2#1"]);
    const first = rec.results.find((r) => r.caseId === "c1" && r.repeatIndex === 1);
    expect(first?.run).toEqual(okRun("c1", 1));
    expect(first?.grades.map((g) => [g.graderId, g.status, g.passed])).toEqual([
      ["field_answer", "graded", true],
      ["quality", "graded", true],
    ]);
    expect(first?.grades[1]).toMatchObject({ rawValue: 5, judgeTokensIn: 100, judgeTokensOut: 50 });
    expect(first?.grades[1].judgeCostUsd).toBeCloseTo((100 * 3 + 50 * 15) / 1e6, 12);
    expect(rec.judgeCost).toHaveLength(4);
    expect(rec.phases).toContain("c1#0:stage_running");
    expect(rec.phases).toContain("c1#0:grading");
    expect(rec.phases).toContain("c1#0:done");
    expect(existsSync(workDirOf(home, plan))).toBe(false);
    expect(tokens.has(plan.evalRunId)).toBe(false);
  });

  it("gives the child only the allowed environment, the guard and the verified flags", async () => {
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    process.env.SOME_HOST_SECRET = "must-not-leak";
    try {
      const { engine, home } = await setup({ keepWorkDir: true });
      const plan = samplePlan({ repeats: 1, concurrency: 3 });
      await engine.run(plan, recordingIo().io, new AbortController().signal);
      const dir = workDirOf(home, plan);
      const seen = JSON.parse(readFileSync(path.join(dir, "env.json"), "utf8")) as {
        env: Record<string, string>;
        argv: string[];
      };
      const allowed = new Set([
        "PATH",
        "HOME",
        "PROMPTFOO_CONFIG_DIR",
        "NODE_OPTIONS",
        "PROMPTFOO_DISABLE_TELEMETRY",
        "PROMPTFOO_DISABLE_UPDATE",
        "PROMPTFOO_DISABLE_SHARING",
        "PROMPTFOO_DISABLE_REMOTE_GENERATION",
        "STAGEFLOW_EVAL_CALLBACK_URL",
        "STAGEFLOW_EVAL_TOKEN",
        "OPENAI_API_KEY",
        "FAKE_MODE",
        "__CF_USER_TEXT_ENCODING",
      ]);
      expect(Object.keys(seen.env).filter((k) => !allowed.has(k))).toEqual([]);
      expect(seen.env.HOME).toBe(dir);
      expect(seen.env.PROMPTFOO_CONFIG_DIR).toBe(path.join(dir, "pf-home"));
      expect(seen.env.PROMPTFOO_DISABLE_TELEMETRY).toBe("1");
      expect(seen.env.PROMPTFOO_DISABLE_UPDATE).toBe("1");
      expect(seen.env.PROMPTFOO_DISABLE_SHARING).toBe("1");
      expect(seen.env.PROMPTFOO_DISABLE_REMOTE_GENERATION).toBe("true");
      expect(seen.env.NODE_OPTIONS).toBe(`--require "${path.join(dir, "guard.cjs")}"`);
      expect(existsSync(path.join(dir, "guard.cjs"))).toBe(true);
      expect(seen.env.OPENAI_API_KEY).toBe("judge-key-value");
      expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seen.argv).toEqual([
        "eval",
        "-c",
        "promptfooconfig.json",
        "--output",
        "results.json",
        "--no-cache",
        "--no-progress-bar",
        "--no-write",
        "--repeat",
        "1",
        "-j",
        "3",
      ]);
      const onDisk = readdirAll(dir);
      expect(onDisk).not.toContain("judge-key-value");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.SOME_HOST_SECRET;
    }
  });

  it("stops on abort after the results already streamed", async () => {
    const { engine } = await setup({}, "hang");
    const rec = recordingIo();
    const abort = new AbortController();
    const done = engine.run(samplePlan(), rec.io, abort.signal);
    const started = Date.now();
    while (rec.results.length < 1 && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await done;
    expect(rec.results).toHaveLength(1);
  });

  it("falls back to SIGKILL when the process ignores SIGTERM", async () => {
    const { engine } = await setup({ killGraceMs: 150 }, "ignore-term");
    const abort = new AbortController();
    const rec = recordingIo();
    const done = engine.run(samplePlan(), rec.io, abort.signal);
    const started = Date.now();
    while (rec.results.length < 1 && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await done;
    expect(rec.results.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("turns a crash without results into EVAL_ENGINE_ERROR, with stderr only in the log", async () => {
    const { engine } = await setup({}, "crash");
    const rec = recordingIo();
    const error = await engine.run(samplePlan(), rec.io, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe("EVAL_ENGINE_ERROR");
    expect((error as EngineError).message).not.toContain("SECRETSTDERR");
    const logged = rec.logs.find((l) => l.level === "error")?.message ?? "";
    expect(logged).toContain("SECRETSTDERR");
    expect(logged.length).toBeLessThan(2048 + 200);
  });

  it("stops the engine when a case hits the budget", async () => {
    const { engine } = await setup({}, "hang");
    const budget: RunCaseResult = { ok: false, code: "EVAL_BUDGET_EXCEEDED", message: "limit" };
    const rec = recordingIo(async () => budget);
    await engine.run(samplePlan(), rec.io, new AbortController().signal);
    expect(rec.results).toHaveLength(1);
    expect(rec.results[0].run).toMatchObject({ ok: false, code: "EVAL_BUDGET_EXCEEDED" });
    expect(rec.results[0].grades).toEqual([]);
  });

  it("fails before any stage run when the engine is not installed", async () => {
    const { engine } = await setup({ binPath: undefined });
    let ran = false;
    const rec = recordingIo(async (req) => {
      ran = true;
      return okRun(req.caseId, req.repeatIndex);
    });
    const error = await engine.run(samplePlan(), rec.io, new AbortController().signal).catch((e: unknown) => e);
    expect((error as EngineError).code).toBe("EVAL_ENGINE_UNAVAILABLE");
    expect(ran).toBe(false);
  });

  it("fails with EVAL_INVALID, naming the supported providers, for an unmapped judge", async () => {
    const { engine } = await setup();
    const base = samplePlan();
    const rubric = base.graders[1];
    if (rubric.type !== "rubric") throw new Error("fixture");
    let ran = false;
    const rec = recordingIo(async (req) => {
      ran = true;
      return okRun(req.caseId, req.repeatIndex);
    });
    const error = await engine
      .run(samplePlan({ graders: [{ ...rubric, judge: "google/gemini-3" }] }), rec.io, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((error as EngineError).code).toBe("EVAL_INVALID");
    expect((error as EngineError).message).toContain("google/gemini-3");
    expect((error as EngineError).message).toContain("anthropic, openai, openrouter");
    expect(ran).toBe(false);
  });

  it("fails with EVAL_INVALID when the judge provider has no API key", async () => {
    const { engine } = await setup({ resolveJudgeKey: () => undefined });
    const error = await engine
      .run(samplePlan(), recordingIo().io, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((error as EngineError).code).toBe("EVAL_INVALID");
    expect((error as EngineError).message).not.toContain("judge-key");
  });
});

function readdirAll(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) text += readdirAll(file);
    else if (name !== "env.json") text += readFileSync(file, "utf8");
  }
  return text;
}
