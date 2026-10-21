import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PromptfooEngine } from "../src/evals/engine/promptfoo/PromptfooEngine.js";
import { RunTokenRegistry } from "../src/evals/engine/promptfoo/runTokens.js";
import { json } from "../src/server/createHttpHost.js";
import { EVAL_INTERNAL_RUN_CASE_PATH, handleEvalInternalRoutes } from "../src/server/evalInternalRoutes.js";
import { okRun, recordingIo, samplePlan } from "./evals/promptfooHelpers.js";

const enabled = process.env.STAGEFLOW_EVALS_SMOKE === "1";

describe.skipIf(!enabled)("PromptfooEngine against the real engine", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("runs a 2-case plan with the stub judge and a fake runner", async () => {
    const stubPort = 20000 + Math.floor(Math.random() * 20000);
    const stub: ChildProcess = spawn(process.execPath, [path.resolve("tests/fixtures/evals/stubJudgeServer.mjs")], {
      env: { ...process.env, STUB_PORT: String(stubPort) },
      stdio: "ignore",
    });
    cleanups.push(() => void stub.kill());
    await new Promise((resolve) => setTimeout(resolve, 500));

    const home = process.env.STAGEFLOW_HOME ?? path.join(process.env.HOME ?? "", ".stageflow");
    const work = mkdtempSync(path.join(tmpdir(), "sf-smoke-"));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const tokens = new RunTokenRegistry();
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleEvalInternalRoutes(
        req,
        req.method ?? "GET",
        url.pathname,
        { tokens, runner: { runCase: async () => Promise.reject(new Error("unused")) }, isRunning: () => true },
        res,
        json,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const callbackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${EVAL_INTERNAL_RUN_CASE_PATH}`;

    const engine = new PromptfooEngine({
      tokens,
      callbackUrl,
      home,
      resolveJudgeKey: () => "stub-key",
      loadJudgePrices: async () => new Map(),
      judgeProviderConfig: { apiBaseUrl: `http://127.0.0.1:${stubPort}/v1` },
    });
    const plan = samplePlan({ repeats: 1, concurrency: 2, evalRunId: "smoke-run" });
    const rec = recordingIo(async (req) => okRun(req.caseId, req.repeatIndex));
    await engine.run(plan, rec.io, new AbortController().signal);

    expect(rec.results).toHaveLength(2);
    for (const result of rec.results) {
      expect(result.run.ok).toBe(true);
      expect(result.grades.map((g) => g.graderId)).toEqual(["field_answer", "quality"]);
      expect(result.grades[1].status).toBe("graded");
    }
  }, 180_000);
});
