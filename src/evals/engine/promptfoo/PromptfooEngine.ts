import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globalStageflowHome } from "../../../project/globalHome.js";
import type {
  EngineIo,
  EvalEngine,
  EvalPlan,
  RunCaseRequest,
  RunCaseResult,
} from "../../types.js";
import { EngineError } from "./errors.js";
import {
  CALLBACK_URL_ENV,
  CONFIG_FILE,
  RESULTS_FILE,
  RESULTS_STREAM_FILE,
  RUN_TOKEN_ENV,
  generateFiles,
} from "./generate.js";
import { GUARD_FILENAME } from "./guard.js";
import { mapJudge, assertJudgesSupported, type JudgeMapping } from "./judgeProviders.js";
import {
  defaultLoadJudgePrices,
  defaultResolveJudgeKey,
  type JudgeKeyResolver,
  type JudgePriceLoader,
} from "./judgeServices.js";
import { locatePromptfoo } from "./locate.js";
import { normalizeRecord, recordIdentity, recordsFromResultsFile, type JudgePrice, type ResultRecord } from "./normalize.js";
import { assertNode } from "./nodeVersion.js";
import { PINNED_PROMPTFOO_VERSION } from "./pinned.js";
import type { RunTokenRegistry } from "./runTokens.js";

export const PROMPTFOO_KILL_GRACE_MS = 5_000;
export const PROMPTFOO_STREAM_POLL_MS = 100;
export const STDERR_TAIL_BYTES = 2048;
export const KEEP_WORKDIR_ENV = "STAGEFLOW_EVALS_KEEP_WORKDIR";

export const DISABLE_FLAGS = {
  PROMPTFOO_DISABLE_TELEMETRY: "1",
  PROMPTFOO_DISABLE_UPDATE: "1",
  PROMPTFOO_DISABLE_SHARING: "1",
  PROMPTFOO_DISABLE_REMOTE_GENERATION: "true",
} as const;

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type PromptfooEngineOptions = {
  tokens: RunTokenRegistry;
  callbackUrl: string | (() => string);
  home?: string;
  spawn?: SpawnFn;
  resolveJudgeKey?: JudgeKeyResolver;
  loadJudgePrices?: JudgePriceLoader;
  graderModuleUrl?: string;
  judgeProviderConfig?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
  killGraceMs?: number;
  streamPollMs?: number;
  keepWorkDir?: boolean;
  nodeVersion?: string;
  binPath?: string;
};

export function quoteNodeOption(file: string): string {
  return `"${file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildChildEnv(input: {
  workDir: string;
  guardPath: string;
  callbackUrl: string;
  token: string;
  judgeEnv: Record<string, string>;
  extraEnv?: Record<string, string>;
  path?: string;
}): Record<string, string> {
  return {
    PATH: input.path ?? process.env.PATH ?? "",
    HOME: input.workDir,
    PROMPTFOO_CONFIG_DIR: path.join(input.workDir, "pf-home"),
    NODE_OPTIONS: `--require ${quoteNodeOption(input.guardPath)}`,
    ...DISABLE_FLAGS,
    [CALLBACK_URL_ENV]: input.callbackUrl,
    [RUN_TOKEN_ENV]: input.token,
    ...input.judgeEnv,
    ...input.extraEnv,
  };
}

export function buildPromptfooArgs(binPath: string, plan: Pick<EvalPlan, "repeats" | "concurrency">): string[] {
  return [
    binPath,
    "eval",
    "-c",
    CONFIG_FILE,
    "--output",
    RESULTS_FILE,
    "--no-cache",
    "--no-progress-bar",
    "--no-write",
    "--repeat",
    String(plan.repeats),
    "-j",
    String(Math.max(1, plan.concurrency)),
  ];
}

export function resolveGraderModuleUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../graders/index.js"),
    path.resolve(here, "../../../../dist/evals/graders/index.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new EngineError(
      "EVAL_ENGINE_UNAVAILABLE",
      "Compiled graders were not found. Run `npm run build` before running evals from source.",
    );
  }
  return pathToFileURL(found).href;
}

class StreamTail {
  private offset = 0;

  constructor(private readonly file: string) {}

  lines(): string[] {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return [];
    }
    if (size <= this.offset) return [];
    const fd = openSync(this.file, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - this.offset);
      readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      closeSync(fd);
    }
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return [];
    this.offset += lastNewline + 1;
    return chunk
      .subarray(0, lastNewline)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  }
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error };

export class PromptfooEngine implements EvalEngine {
  readonly name = "promptfoo";

  constructor(private readonly options: PromptfooEngineOptions) {}

  private home(): string {
    return this.options.home ?? globalStageflowHome();
  }

  async version(): Promise<string> {
    return PINNED_PROMPTFOO_VERSION;
  }

  validatePlan(plan: EvalPlan): void {
    assertJudgesSupported(plan.graders);
  }

  async run(plan: EvalPlan, io: EngineIo, signal: AbortSignal): Promise<void> {
    const opts = this.options;
    assertNode(opts.nodeVersion);
    assertJudgesSupported(plan.graders);

    const located = locatePromptfoo({ home: this.home() });
    if (!located.installed && opts.binPath === undefined) {
      throw new EngineError("EVAL_ENGINE_UNAVAILABLE", located.reason);
    }
    const binPath = opts.binPath ?? (located.installed ? located.binPath : "");

    const judgeEnv: Record<string, string> = {};
    const judgeModels = new Set<string>();
    for (const grader of plan.graders) {
      if (grader.type !== "rubric" && grader.type !== "goal_reached") continue;
      judgeModels.add(grader.judge);
      const mapping = mapJudge(grader.judge) as JudgeMapping;
      if (judgeEnv[mapping.envVar] !== undefined) continue;
      const key = await (opts.resolveJudgeKey ?? defaultResolveJudgeKey)(mapping, plan.projectRoot);
      if (key === undefined) {
        throw new EngineError(
          "EVAL_INVALID",
          `No API key is configured for judge provider "${mapping.stageflowProvider}" (model "${grader.judge}").`,
        );
      }
      judgeEnv[mapping.envVar] = key;
    }
    const prices = await (opts.loadJudgePrices ?? defaultLoadJudgePrices)([...judgeModels], plan.projectRoot);
    const judgePrice = (model: string): JudgePrice | undefined => prices.get(model);

    const graderModuleUrl = opts.graderModuleUrl ?? resolveGraderModuleUrl();
    const files = generateFiles(plan, {
      graderModuleUrl,
      ...(opts.judgeProviderConfig !== undefined ? { judgeProviderConfig: opts.judgeProviderConfig } : {}),
    });

    if (signal.aborted) return;

    const workDir = path.join(this.home(), "eval-runs", plan.evalRunId);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(path.join(workDir, "pf-home"), { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(workDir, name), content);

    const hostRuns = new Map<string, RunCaseResult>();
    const keyOf = (caseId: string, repeatIndex: number): string => `${caseId}#${repeatIndex}`;
    const runCase = async (req: RunCaseRequest): Promise<RunCaseResult> => {
      io.onPhase(req.caseId, req.repeatIndex, plan.target.kind === "agent" ? "agent_running" : "stage_running");
      const result = await io.runCase(req);
      hostRuns.set(keyOf(req.caseId, req.repeatIndex), result);
      if (result.ok) io.onPhase(req.caseId, req.repeatIndex, "grading");
      return result;
    };

    const token = opts.tokens.issue(plan.evalRunId, { plan, runCase });
    const callbackUrl = typeof opts.callbackUrl === "function" ? opts.callbackUrl() : opts.callbackUrl;
    const env = buildChildEnv({
      workDir,
      guardPath: path.join(workDir, GUARD_FILENAME),
      callbackUrl,
      token,
      judgeEnv,
      ...(opts.extraEnv !== undefined ? { extraEnv: opts.extraEnv } : {}),
    });

    const emitted = new Set<string>();
    const warnedPrice = new Set<string>();
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let exited = false;

    const terminate = (): void => {
      if (child === undefined || exited || stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) child?.kill("SIGKILL");
      }, opts.killGraceMs ?? PROMPTFOO_KILL_GRACE_MS);
    };

    const handleRecord = (record: ResultRecord): void => {
      const identity = recordIdentity(record, plan);
      if (identity === undefined) return;
      const key = keyOf(identity.caseId, identity.repeatIndex);
      if (emitted.has(key)) return;
      emitted.add(key);
      const outcome = normalizeRecord(record, identity, plan, {
        hostRun: (caseId, repeatIndex) => hostRuns.get(keyOf(caseId, repeatIndex)),
        judgePrice,
      });
      for (const model of outcome.priceUnknownModels) {
        if (warnedPrice.has(model)) continue;
        warnedPrice.add(model);
        io.log("warn", `No catalog price for judge model ${model}; its cost is counted as $0.`);
      }
      io.onResult(outcome.result);
      if (outcome.judgeCostUsd > 0) io.reportJudgeCost(outcome.judgeCostUsd);
      io.onPhase(identity.caseId, identity.repeatIndex, "done");
      const run = outcome.result.run;
      if (!run.ok && run.code === "EVAL_BUDGET_EXCEEDED") terminate();
    };

    const tail = new StreamTail(path.join(workDir, RESULTS_STREAM_FILE));
    const drain = (): void => {
      for (const line of tail.lines()) {
        try {
          handleRecord(JSON.parse(line) as ResultRecord);
        } catch {
          io.log("warn", "Skipped an unreadable progress line from the eval engine.");
        }
      }
    };

    const onAbort = (): void => terminate();
    let poll: NodeJS.Timeout | undefined;
    let stderrTail = "";
    try {
      const exit = await new Promise<ChildExit>((resolve) => {
        try {
          child = (opts.spawn ?? nodeSpawn)(process.execPath, buildPromptfooArgs(binPath, plan), {
            cwd: workDir,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          resolve({ code: null, signal: null, spawnError: error instanceof Error ? error : new Error(String(error)) });
          return;
        }
        child.stdout?.on("data", () => undefined);
        child.stderr?.on("data", (data: Buffer | string) => {
          stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_BYTES);
        });
        child.on("error", (error) => {
          exited = true;
          resolve({ code: null, signal: null, spawnError: error });
        });
        child.on("close", (code, sig) => {
          exited = true;
          resolve({ code, signal: sig });
        });
        poll = setInterval(drain, opts.streamPollMs ?? PROMPTFOO_STREAM_POLL_MS);
        if (signal.aborted) terminate();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      if (poll !== undefined) clearInterval(poll);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      drain();

      if (stopping || signal.aborted) return;

      const fail = (message: string): never => {
        if (stderrTail.length > 0) io.log("error", `promptfoo stderr (last ${STDERR_TAIL_BYTES} bytes): ${stderrTail}`);
        throw new EngineError("EVAL_ENGINE_ERROR", message);
      };
      if (exit.spawnError !== undefined) fail("The eval engine could not be started");
      if (exit.code !== 0 && exit.code !== 100) fail(`The eval engine exited with code ${exit.code ?? exit.signal ?? "unknown"}`);
      const resultsFile = path.join(workDir, RESULTS_FILE);
      if (!existsSync(resultsFile)) fail("The eval engine wrote no results");
      let records: ResultRecord[] | undefined;
      try {
        records = recordsFromResultsFile(JSON.parse(readFileSync(resultsFile, "utf8")));
      } catch {
        records = undefined;
      }
      if (records === undefined) fail("The eval engine results could not be read");
      for (const record of records ?? []) handleRecord(record);
    } finally {
      if (poll !== undefined) clearInterval(poll);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      opts.tokens.revoke(plan.evalRunId);
      if (!(opts.keepWorkDir ?? process.env[KEEP_WORKDIR_ENV] === "1")) {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  }
}
