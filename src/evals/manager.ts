import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { loadEvalOutcome } from "../config/loadEval.js";
import type { AgentCatalogPort } from "../config/resolveAgentTarget.js";
import type { ValidationFinding } from "../config/validateCatalog.js";
import type { RunStore } from "../runstore/port.js";
import {
  EVAL_RUN_ID_PREFIX,
  type EvalBudgetWarning,
  type EvalErrorCode,
  type EvalResultStatus,
  type EvalStartedVia,
} from "./constants.js";
import { getEngine } from "./engine/index.js";
import { buildEvalPlan, type EvalOverrides } from "./plan.js";
import type { StageCaseRunner } from "./runner/stageCaseRunner.js";
import { scoreResult, type ScoringGrader } from "./scoring.js";
import { computeStats, type Stats } from "./stats.js";
import { toGradeRecords, toResultRecord } from "./statsAdapter.js";
import type { EvalGradeInput, EvalJson, EvalResultInput, EvalResultWithGrades, EvalRunRow } from "./storeTypes.js";
import type {
  EngineIo,
  EvalEngine,
  EvalFile,
  EvalPlan,
  NormalizedGrade,
  NormalizedResult,
  ConversationOutput,
  PlanCase,
  RunCaseFailureCode,
  RunCaseRequest,
  RunCaseResult,
} from "./types.js";

export const EVAL_HOST_STOPPED_REASON = "Host stopped while the run was in progress";
export const EVAL_DEFAULT_ENGINE = "promptfoo";

export type EvalManagerStore = Pick<
  RunStore,
  | "createEvalRun"
  | "insertEvalCases"
  | "upsertEvalResult"
  | "updateEvalRunProgress"
  | "finishEvalRun"
  | "getEvalRun"
  | "listEvalRuns"
  | "listEvalResults"
  | "recordGraderVersions"
>;

export type EvalLogger = {
  info?(code: string, message: string): void;
  warn(code: string, message: string): void;
  error(code: string, message: string): void;
};

export type EvalRunContext = {
  plan: EvalPlan;
  engineName: string;
  runCase: (req: RunCaseRequest) => Promise<RunCaseResult>;
  signal: AbortSignal;
};

/** What the manager needs from the agent service: plan resolution and cleanup of eval sessions. */
export type EvalAgentsPort = AgentCatalogPort & {
  deleteEvalSessions(projectRoot: string, sessionIds: string[]): Promise<string[]>;
  sweepEvalSessions(input: {
    runIds: string[];
    olderThanMs: number;
    isReferenced: (sessionId: string) => Promise<boolean> | boolean;
  }): Promise<number>;
};

export const EVAL_ORPHAN_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type EvalRunManagerDeps = {
  store: EvalManagerStore;
  stageRunner: StageCaseRunner;
  /** Lazy: the manager is built before the agent host. Absent or undefined means agents are unavailable. */
  agents?: () => EvalAgentsPort | undefined;
  engines?: (name: string, options?: unknown) => EvalEngine;
  engineName?: string;
  stageflowVersion: string;
  now?: () => Date;
  logger?: EvalLogger;
  workDirRoot: string;
  isKnownModel?: (id: string) => Promise<boolean>;
  onRunStarted?(evalRunId: string, ctx: EvalRunContext): void | Promise<void>;
  onRunFinished?(evalRunId: string): void | Promise<void>;
};

export class EvalRunError extends Error {
  constructor(
    readonly code: EvalErrorCode,
    message: string,
    readonly findings?: ValidationFinding[],
  ) {
    super(message);
    this.name = "EvalRunError";
  }
}

export type StartEvalRunInput = {
  projectRoot: string;
  evalPath: string;
  overrides?: EvalOverrides;
  startedVia: EvalStartedVia;
  callerId?: string;
  label?: string;
};

export type TryCaseInput = {
  id?: string;
  input: Record<string, unknown>;
  expected?: unknown;
  tags?: string[];
  title?: string;
  goal?: string;
  metadata?: unknown;
};

export type TryOneInput = {
  projectRoot: string;
  evalPath: string;
  definition?: EvalFile | string;
  datasetCases?: readonly unknown[];
  caseId?: string;
  case?: TryCaseInput;
  /** The per-run consent to `conversation.tools: real`. */
  allowRealTools?: boolean;
};

export type TryGrade = {
  graderId: string;
  graderType: string;
  status: "graded" | "error";
  passed: boolean | null;
  score: number | null;
  rawValue: number | null;
  reason: string | null;
  errorCode: string | null;
  details: unknown;
  judgeCostUsd: number | null;
};

export type TryResult = {
  result: {
    caseId: string;
    status: EvalResultStatus;
    errorCode: string | null;
    errorMessage: string | null;
    stageRunId: string | null;
    subjectRef: string | null;
    output: EvalJson | null;
    latencyMs: number | null;
    costUsd: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    score: number | null;
    passed: boolean;
    hasGraderErrors: boolean;
    budgetWarnings: EvalBudgetWarning[];
    grades: TryGrade[];
  };
  grades: TryGrade[];
  stageRunId: string | null;
  costUsd: number;
};

export type LivePhase = { caseId: string; repeatIndex: number; phase: "stage_running" | "agent_running" | "grading" };

export type EvalLiveState = { evalRunId: string; phases: LivePhase[] };

export type AwaitFinishedResult = { finished: boolean; run: EvalRunRow };

type Live = {
  evalRunId: string;
  plan: EvalPlan;
  abort: AbortController;
  phases: Map<string, LivePhase>;
  emitted: Set<string>;
  writes: Promise<void>;
  persistError?: unknown;
  cancelRequested: boolean;
  skippedBudget: boolean;
  providerStop?: string;
  resultsDone: number;
  finished: Promise<EvalRunRow>;
};

const key = (caseId: string, repeatIndex: number): string => `${caseId}:${repeatIndex}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const first = raw.split("\n")[0]?.trim() ?? "";
  return first === "" ? "Eval engine failed" : first.slice(0, 300);
}

const RESULT_STATUS_BY_CODE: Record<RunCaseFailureCode, EvalResultStatus> = {
  EVAL_STAGE_FAILED: "stage_failed",
  EVAL_STAGE_TIMEOUT: "stage_failed",
  EVAL_STAGE_NEEDS_INPUT: "needs_input",
  EVAL_BUDGET_EXCEEDED: "skipped_budget",
  EVAL_CANCELLED: "cancelled",
  EVAL_ENGINE_ERROR: "error",
  EVAL_AGENT_FAILED: "stage_failed",
  EVAL_AGENT_EMPTY_REPLY: "error",
  EVAL_AGENT_TIMEOUT: "stage_failed",
  EVAL_SIMULATOR_ERROR: "error",
};

function conversationFields(output: ConversationOutput): Pick<EvalResultInput, "output" | "turns" | "toolCallCount"> {
  const { transcript: _transport, ...stored } = output;
  return {
    output: stored as unknown as EvalJson,
    turns: output.turns,
    toolCallCount: output.tool_calls.length,
  };
}

const EXECUTED: readonly EvalResultStatus[] = ["completed", "stage_failed", "needs_input", "error"];

function scoringGraders(plan: EvalPlan): ScoringGrader[] {
  return plan.graders.map((g) => ({
    id: g.id,
    type: g.type,
    weight: g.weight,
    mustPass: g.mustPass,
    ...(g.type === "rubric" ? { scale: g.scale } : {}),
    ...(g.type === "rubric" || g.type === "reference" ? { passAt: g.passAt } : {}),
  }));
}

function detailsOf(details: unknown): EvalJson | null {
  if (details === undefined || details === null) return null;
  return isRecord(details) ? details : { value: details };
}

function gradeInput(g: NormalizedGrade): EvalGradeInput {
  return {
    graderId: g.graderId,
    graderType: g.graderType,
    status: g.status,
    passed: g.passed ?? null,
    score: g.score ?? null,
    rawValue: g.rawValue ?? null,
    reason: g.reason ?? null,
    details: detailsOf(g.details),
    errorCode: g.errorCode ?? null,
    judgeModel: g.judgeModel ?? null,
    judgeCostUsd: g.judgeCostUsd ?? null,
    judgeTokensIn: g.judgeTokensIn ?? null,
    judgeTokensOut: g.judgeTokensOut ?? null,
  };
}

export class EvalRunManager {
  private readonly store: EvalManagerStore;
  private readonly runner: StageCaseRunner;
  private readonly engines: (name: string, options?: unknown) => EvalEngine;
  private readonly engineName: string;
  private readonly now: () => Date;
  private live: Live | undefined;
  private reserved = false;
  private trying = false;
  private tryingRunId: string | null = null;

  constructor(private readonly deps: EvalRunManagerDeps) {
    this.store = deps.store;
    this.runner = deps.stageRunner;
    this.engines = deps.engines ?? getEngine;
    this.engineName = deps.engineName ?? EVAL_DEFAULT_ENGINE;
    this.now = deps.now ?? (() => new Date());
  }

  activeRunId(): string | null {
    return this.live?.evalRunId ?? null;
  }

  isExecuting(evalRunId: string): boolean {
    return this.live?.evalRunId === evalRunId || this.tryingRunId === evalRunId;
  }

  getLive(evalRunId: string): EvalLiveState | null {
    const live = this.live;
    if (live === undefined || live.evalRunId !== evalRunId) return null;
    return { evalRunId, phases: [...live.phases.values()] };
  }

  private claim(): void {
    if (this.live !== undefined || this.reserved || this.trying) {
      throw new EvalRunError(
        "EVAL_RUN_ACTIVE",
        this.trying ? "A case is being tried; wait for it to finish" : "An eval run is already active",
      );
    }
    this.reserved = true;
  }

  async start(input: StartEvalRunInput): Promise<{ evalRunId: string; runNumber: number }> {
    this.claim();
    let handedOff = false;
    try {
      const engine = this.engines(this.engineName);
      const engineInfo = {
        name: engine.name,
        version: await engine.version(),
        nodeVersion: process.versions.node,
      };
      const base = {
        projectRoot: input.projectRoot,
        evalPath: input.evalPath,
        ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
        evalRunId: "er_pending",
        engine: engineInfo,
        failedCaseIdsOf: (id: string) => this.failedCaseIds(input.projectRoot, input.evalPath, id),
        ...(this.deps.isKnownModel ? { isKnownModel: this.deps.isKnownModel } : {}),
        ...this.agentsInput(),
      };
      const first = await buildEvalPlan(base);
      if (!first.ok) throw new EvalRunError("EVAL_INVALID", "Eval is invalid", first.findings);

      const ordinals = await this.store.recordGraderVersions(
        input.projectRoot,
        first.plan.evalId,
        first.plan.graders.map((g) => ({ graderId: g.id, graderHash: g.hash })),
      );
      const built = await buildEvalPlan({ ...base, graderOrdinals: ordinals });
      if (!built.ok) throw new EvalRunError("EVAL_INVALID", "Eval is invalid", built.findings);
      const { plan: draft, snapshot, fingerprint, components } = built;
      try {
        engine.validatePlan?.(draft);
      } catch (err) {
        throw new EvalRunError("EVAL_INVALID", err instanceof Error ? err.message : String(err));
      }

      this.requireRealToolsConsent(draft, input.overrides);
      const stageTarget = snapshot.target.kind === "stage" ? snapshot.target : null;
      const agentTarget = snapshot.target.kind === "agent" ? snapshot.target : null;
      const row = await this.store.createEvalRun({
        projectRoot: input.projectRoot,
        evalId: draft.evalId,
        evalPath: snapshot.eval.path,
        evalHash: snapshot.eval.hash,
        targetKind: agentTarget !== null ? "agent" : "stage",
        targetRef:
          agentTarget !== null
            ? { agent_id: agentTarget.agent_id, revision: agentTarget.revision }
            : {
                ...(stageTarget?.pipeline_path != null ? { pipeline_path: stageTarget.pipeline_path } : {}),
                ...(stageTarget?.stage_id != null ? { stage_id: stageTarget.stage_id } : {}),
                ...(stageTarget?.file != null ? { file: stageTarget.file } : {}),
              },
        targetVersionHash: draft.targetVersionHash,
        datasetPath: snapshot.dataset.path,
        datasetHash: snapshot.dataset.hash,
        config: snapshot as unknown as EvalJson,
        configFingerprint: fingerprint,
        configComponents: components as unknown as EvalJson,
        status: "queued",
        repeats: draft.repeats,
        passThreshold: draft.passThreshold,
        maxCostUsd: draft.maxCostUsd,
        casesTotal: draft.cases.length,
        resultsTotal: draft.cases.length * draft.repeats,
        engineName: engineInfo.name,
        engineVersion: engineInfo.version,
        stageflowVersion: this.deps.stageflowVersion,
        startedVia: input.startedVia,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.callerId !== undefined ? { callerId: input.callerId } : {}),
      });
      const plan: EvalPlan = { ...draft, evalRunId: row.evalRunId };
      await this.store.insertEvalCases(
        row.evalRunId,
        plan.cases.map((c) => {
          const { position, ...rest } = c;
          return { caseId: c.id, position, case: rest as unknown as EvalJson };
        }),
      );

      const live: Live = {
        evalRunId: row.evalRunId,
        plan,
        abort: new AbortController(),
        phases: new Map(),
        emitted: new Set(),
        writes: Promise.resolve(),
        cancelRequested: false,
        skippedBudget: false,
        resultsDone: 0,
        finished: undefined as unknown as Promise<EvalRunRow>,
      };
      this.live = live;
      this.reserved = false;
      handedOff = true;
      live.finished = this.execute(live, engine);
      live.finished.catch(() => undefined);
      return { evalRunId: row.evalRunId, runNumber: row.runNumber };
    } finally {
      if (!handedOff) this.reserved = false;
    }
  }

  private async failedCaseIds(
    projectRoot: string,
    evalPath: string,
    evalRunId: string,
  ): Promise<string[] | undefined> {
    const run = await this.store.getEvalRun(evalRunId);
    if (run === null || run.projectRoot !== projectRoot) return undefined;
    const evalRel = path.relative(projectRoot, path.resolve(projectRoot, evalPath)).split(path.sep).join("/");
    if (run.evalPath !== evalRel) return undefined;
    const results = await this.store.listEvalResults(evalRunId);
    const failed = results.filter((r) => EXECUTED.includes(r.status) && !r.passed);
    return [...new Set(failed.map((r) => r.caseId))];
  }

  private makeIo(
    plan: EvalPlan,
    onResult: (result: NormalizedResult) => void,
    onPhase: EngineIo["onPhase"],
  ): EngineIo {
    const { logger } = this.deps;
    return {
      runCase: (req) => this.runner.runCase(plan, req),
      onResult,
      reportJudgeCost: (usd) => {
        if (Number.isFinite(usd) && usd > 0) this.runner.addSpend(plan.evalRunId, usd);
      },
      onPhase,
      log: (level, message) => {
        if (level === "info") logger?.info?.("eval.engine", message);
        else logger?.[level]("eval.engine", message);
      },
    };
  }

  private async runHook(name: string, hook: () => void | Promise<void>): Promise<void> {
    try {
      await hook();
    } catch (err) {
      this.deps.logger?.warn("eval.hook_failed", `${name}: ${safeMessage(err)}`);
    }
  }

  private async execute(live: Live, engine: EvalEngine): Promise<EvalRunRow> {
    const { plan, evalRunId } = live;
    try {
      await this.store.updateEvalRunProgress(evalRunId, {
        status: "running",
        startedAt: this.now().toISOString(),
      });
      const io = this.makeIo(
        plan,
        (result) => this.enqueuePersist(live, result),
        (caseId, repeatIndex, phase) => {
          const k = key(caseId, repeatIndex);
          if (phase === "done") live.phases.delete(k);
          else live.phases.set(k, { caseId, repeatIndex, phase });
        },
      );
      const { onRunStarted } = this.deps;
      if (onRunStarted) {
        await this.runHook("onRunStarted", () =>
          onRunStarted(evalRunId, {
            plan,
            engineName: engine.name,
            runCase: io.runCase,
            signal: live.abort.signal,
          }),
        );
      }
      let crashed = false;
      let crash: unknown;
      try {
        await engine.run(plan, io, live.abort.signal);
      } catch (err) {
        crashed = true;
        crash = err;
        this.deps.logger?.error("eval.engine_failed", safeMessage(err));
      }
      await live.writes;
      return await this.finish(live, crashed, crash);
    } catch (err) {
      this.deps.logger?.error("eval.finish_failed", safeMessage(err));
      await live.writes.catch(() => undefined);
      return await this.finishFailed(live, safeMessage(err));
    } finally {
      live.phases.clear();
      await this.cleanupWorkDir(evalRunId);
      const { onRunFinished } = this.deps;
      if (onRunFinished) await this.runHook("onRunFinished", () => onRunFinished(evalRunId));
      if (this.live === live) this.live = undefined;
    }
  }

  private enqueuePersist(live: Live, result: NormalizedResult): void {
    const k = key(result.caseId, result.repeatIndex);
    if (live.emitted.has(k)) return;
    live.emitted.add(k);
    live.phases.delete(k);
    const input = this.resultInput(live.plan, result);
    if (input.status === "skipped_budget") live.skippedBudget = true;
    const stopReason = this.runner.stopReason?.(live.evalRunId);
    if (stopReason !== undefined && live.providerStop === undefined && !live.cancelRequested) {
      live.providerStop = stopReason;
      live.abort.abort();
      void this.runner.cancelAll(live.evalRunId).catch(() => undefined);
    }
    live.writes = live.writes.then(async () => {
      if (live.persistError !== undefined) return;
      try {
        await this.store.upsertEvalResult(input);
        live.resultsDone += 1;
        await this.store.updateEvalRunProgress(live.evalRunId, {
          resultsDone: live.resultsDone,
          costUsd: this.runner.spend(live.evalRunId),
        });
      } catch (err) {
        live.persistError = err;
        live.abort.abort();
        this.deps.logger?.error("eval.persist_failed", safeMessage(err));
      }
    });
  }

  private resultInput(plan: EvalPlan, nr: NormalizedResult): EvalResultInput {
    const finishedAt = this.now();
    const { run } = nr;
    const base = { evalRunId: plan.evalRunId, caseId: nr.caseId, repeatIndex: nr.repeatIndex };
    const timing = (latencyMs: number | undefined) => ({
      startedAt: latencyMs !== undefined ? new Date(finishedAt.getTime() - latencyMs).toISOString() : null,
      finishedAt: finishedAt.toISOString(),
    });
    if (!run.ok) {
      const status = RESULT_STATUS_BY_CODE[run.code] ?? "error";
      const scored = scoreResult({
        graders: [],
        grades: [],
        passThreshold: plan.passThreshold,
        status,
        latencyMs: run.latencyMs ?? null,
        costUsd: run.costUsd ?? null,
        budget: plan.budget,
      });
      return {
        ...base,
        status,
        errorCode: run.code,
        errorMessage: run.message,
        stageRunId: run.stageRunId ?? null,
        ...(run.subjectRef !== undefined || run.stageRunId !== undefined
          ? { subjectRef: run.subjectRef ?? run.stageRunId ?? null }
          : {}),
        ...(run.output !== undefined ? conversationFields(run.output) : {}),
        latencyMs: run.latencyMs ?? null,
        costUsd: run.costUsd ?? null,
        score: null,
        passed: false,
        hasGraderErrors: false,
        budgetWarnings: scored.budgetWarnings,
        ...timing(run.latencyMs),
      };
    }
    const scored = scoreResult({
      graders: scoringGraders(plan),
      grades: nr.grades.map((g) => ({
        graderId: g.graderId,
        status: g.status,
        passed: g.passed ?? null,
        score: g.score ?? null,
        rawValue: g.rawValue ?? null,
      })),
      passThreshold: plan.passThreshold,
      status: "completed",
      latencyMs: run.latencyMs,
      costUsd: run.costUsd,
      budget: plan.budget,
    });
    const { output } = run;
    return {
      ...base,
      status: "completed",
      stageRunId: run.stageRunId ?? null,
      subjectRef: run.subjectRef ?? run.stageRunId ?? null,
      ...(output.kind === "conversation"
        ? conversationFields(output)
        : {
            output: {
              status: output.status,
              summary: output.summary,
              ...(output.payload !== undefined ? { payload: output.payload } : {}),
              artifacts: output.artifacts,
            },
          }),
      latencyMs: run.latencyMs,
      costUsd: run.costUsd,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      score: scored.score,
      passed: scored.passed,
      hasGraderErrors: scored.hasGraderErrors,
      budgetWarnings: scored.budgetWarnings,
      ...timing(run.latencyMs),
      grades: nr.grades.map(gradeInput),
    };
  }

  private statsFor(
    plan: Pick<EvalPlan, "graders" | "repeats" | "passThreshold"> & { target?: { kind: string } },
    results: EvalResultWithGrades[],
  ): Stats {
    return computeStats({
      ...(plan.target?.kind === "agent" ? { targetKind: "agent" as const } : {}),
      results: results.map(toResultRecord),
      grades: results.flatMap(toGradeRecords),
      graders: plan.graders.map((g) => ({ id: g.id, type: g.type, hash: g.hash })),
      repeats: plan.repeats,
      passThreshold: plan.passThreshold,
    });
  }

  private summaryOf(stats: Stats): EvalJson {
    return {
      pass_rate: stats.pass_rate,
      pass_rate_ci: stats.pass_rate_ci,
      results_executed: stats.results_executed,
      results_passed: stats.results_passed,
      errored: stats.errored,
      reliability: stats.reliability,
      mean_score: stats.mean_score,
      cost_total: stats.cost_total,
      latency_p50: stats.latency_p50,
      flaky_count: stats.flaky_cases.length,
      ...(stats.mean_turns !== undefined ? { mean_turns: stats.mean_turns } : {}),
      ...(stats.mean_tool_calls !== undefined ? { mean_tool_calls: stats.mean_tool_calls } : {}),
    };
  }

  private async fillRemainder(live: Live, kind: "cancelled" | "skipped_budget" | "error", message?: string): Promise<void> {
    const { plan } = live;
    const finishedAt = this.now().toISOString();
    const detail =
      kind === "cancelled"
        ? { errorCode: "EVAL_CANCELLED", errorMessage: message ?? "Eval run was cancelled" }
        : kind === "skipped_budget"
          ? { errorCode: "EVAL_BUDGET_EXCEEDED", errorMessage: `Eval spend reached the $${plan.maxCostUsd} limit` }
          : { errorCode: "EVAL_ENGINE_ERROR", errorMessage: "Engine finished without a result for this case" };
    for (const c of plan.cases) {
      for (let repeatIndex = 0; repeatIndex < plan.repeats; repeatIndex++) {
        const k = key(c.id, repeatIndex);
        if (live.emitted.has(k)) continue;
        live.emitted.add(k);
        await this.store.upsertEvalResult({
          evalRunId: plan.evalRunId,
          caseId: c.id,
          repeatIndex,
          status: kind,
          ...detail,
          score: null,
          passed: false,
          finishedAt,
        });
        live.resultsDone += 1;
      }
    }
  }

  private async finish(live: Live, crashed: boolean, crash: unknown): Promise<EvalRunRow> {
    const { plan, evalRunId } = live;
    const total = plan.cases.length * plan.repeats;
    let status: "completed" | "failed" | "cancelled" | "budget_stopped" = "completed";
    let reason: string | null = null;
    if (live.persistError !== undefined) {
      status = "failed";
      reason = "Could not save eval results";
    } else if (crashed) {
      status = "failed";
      reason = safeMessage(crash);
    } else if (live.providerStop !== undefined && !live.cancelRequested) {
      status = "failed";
      reason = live.providerStop;
      await this.fillRemainder(live, "cancelled", live.providerStop);
    } else if (live.cancelRequested) {
      status = "cancelled";
      reason = "Cancelled";
      await this.fillRemainder(live, "cancelled");
    } else if (live.skippedBudget || (live.emitted.size < total && this.runner.spend(evalRunId) >= plan.maxCostUsd)) {
      status = "budget_stopped";
      reason = `Reached the $${plan.maxCostUsd} cost limit`;
      await this.fillRemainder(live, "skipped_budget");
    } else if (live.emitted.size < total) {
      await this.fillRemainder(live, "error");
    }
    const results = await this.store.listEvalResults(evalRunId);
    const stats = this.statsFor(plan, results);
    const passed =
      status === "completed" && stats.pass_rate !== null && stats.pass_rate + 1e-9 >= plan.passThreshold;
    await this.store.updateEvalRunProgress(evalRunId, { resultsDone: live.resultsDone, costUsd: stats.cost_total });
    await this.store.finishEvalRun(evalRunId, {
      status,
      statusReason: reason,
      passed,
      summary: this.summaryOf(stats),
      finishedAt: this.now().toISOString(),
    });
    return (await this.store.getEvalRun(evalRunId))!;
  }

  private async finishFailed(live: Live, reason: string): Promise<EvalRunRow> {
    const results = await this.store.listEvalResults(live.evalRunId);
    await this.store.finishEvalRun(live.evalRunId, {
      status: "failed",
      statusReason: reason,
      passed: false,
      summary: this.summaryOf(this.statsFor(live.plan, results)),
      finishedAt: this.now().toISOString(),
    });
    return (await this.store.getEvalRun(live.evalRunId))!;
  }

  private async cleanupWorkDir(evalRunId: string): Promise<void> {
    if (process.env.STAGEFLOW_EVALS_KEEP_WORKDIR === "1") return;
    try {
      await rm(path.join(this.deps.workDirRoot, evalRunId), { recursive: true, force: true });
    } catch (err) {
      this.deps.logger?.warn("eval.workdir_cleanup_failed", safeMessage(err));
    }
  }

  async cancel(evalRunId: string): Promise<boolean> {
    const live = this.live;
    if (live === undefined || live.evalRunId !== evalRunId) {
      if ((await this.store.getEvalRun(evalRunId)) === null) {
        throw new EvalRunError("EVAL_RUN_NOT_FOUND", `Eval run not found: ${evalRunId}`);
      }
      return false;
    }
    if (live.cancelRequested) return true;
    live.cancelRequested = true;
    live.abort.abort();
    await this.runner.cancelAll(evalRunId);
    return true;
  }

  async awaitFinished(evalRunId: string, timeoutMs: number): Promise<AwaitFinishedResult> {
    const live = this.live;
    if (live !== undefined && live.evalRunId === evalRunId) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
      });
      try {
        const winner = await Promise.race([live.finished, timeout]);
        if (winner !== "timeout") return { finished: true, run: winner };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    const run = await this.store.getEvalRun(evalRunId);
    if (run === null) throw new EvalRunError("EVAL_RUN_NOT_FOUND", `Eval run not found: ${evalRunId}`);
    return { finished: run.status !== "queued" && run.status !== "running", run };
  }

  private requireRealToolsConsent(plan: EvalPlan, overrides: EvalOverrides | undefined): void {
    if (plan.target.kind === "agent" && plan.conversation?.tools === "real" && overrides?.allow_real_tools !== true) {
      throw new EvalRunError(
        "EVAL_REAL_TOOLS_NOT_CONFIRMED",
        "This eval uses real tools, which can change files and call services from this machine. Confirm with allow_real_tools to run it.",
      );
    }
  }

  /**
   * Validation and the real-tools consent for an agent eval, without claiming the run slot, so a transport can answer
   * them before it checks the engine. Does nothing for stage evals and unreadable files.
   */
  async preflightAgentStart(input: StartEvalRunInput): Promise<void> {
    const outcome = await loadEvalOutcome(path.resolve(input.projectRoot, input.evalPath), input.projectRoot);
    if (!outcome.ok || outcome.value.file.target.kind !== "agent") return;
    const built = await buildEvalPlan({
      projectRoot: input.projectRoot,
      evalPath: input.evalPath,
      ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
      evalRunId: "er_preflight",
      engine: { name: this.engineName, version: "preflight", nodeVersion: process.versions.node },
      failedCaseIdsOf: (id: string) => this.failedCaseIds(input.projectRoot, input.evalPath, id),
      ...(this.deps.isKnownModel ? { isKnownModel: this.deps.isKnownModel } : {}),
      ...this.agentsInput(),
    });
    if (!built.ok) throw new EvalRunError("EVAL_INVALID", "Eval is invalid", built.findings);
    this.requireRealToolsConsent(built.plan, input.overrides);
  }

  private agentsInput(): { agents?: AgentCatalogPort } {
    const agents = this.deps.agents?.();
    return agents ? { agents } : {};
  }

  /** Delete the agent sessions of recovered runs and eval sessions older than 7 days that no result references. */
  async sweepAgentSessions(recoveredRunIds: string[]): Promise<number> {
    const agents = this.deps.agents?.();
    if (!agents) return 0;
    try {
      return await agents.sweepEvalSessions({
        runIds: recoveredRunIds,
        olderThanMs: EVAL_ORPHAN_SESSION_MAX_AGE_MS,
        isReferenced: async (sessionId) =>
          (await this.store.listEvalRuns({ subjectRef: sessionId, limit: 1 })).items.length > 0,
      });
    } catch (err) {
      this.deps.logger?.warn("eval.session_sweep_failed", safeMessage(err));
      return 0;
    }
  }

  async recoverOnBoot(): Promise<string[]> {
    const recovered: string[] = [];
    for (const status of ["queued", "running"] as const) {
      let cursor: string | undefined;
      do {
        const page = await this.store.listEvalRuns({
          status,
          limit: 200,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const run of page.items) {
          let summary: EvalJson = {};
          try {
            const results = await this.store.listEvalResults(run.evalRunId);
            summary = this.summaryOf(
              this.statsFor(
                { graders: [], repeats: run.repeats, passThreshold: run.passThreshold, target: { kind: run.targetKind } },
                results,
              ),
            );
          } catch (err) {
            this.deps.logger?.warn("eval.recover_summary_failed", safeMessage(err));
          }
          await this.store.finishEvalRun(run.evalRunId, {
            status: "failed",
            statusReason: EVAL_HOST_STOPPED_REASON,
            passed: false,
            summary,
            finishedAt: this.now().toISOString(),
          });
          recovered.push(run.evalRunId);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    }
    return recovered;
  }

  private async dropTrySession(tried: { projectRoot: string; subjectRef: string } | undefined): Promise<void> {
    if (!tried) return;
    try {
      await this.deps.agents?.()?.deleteEvalSessions(tried.projectRoot, [tried.subjectRef]);
    } catch (err) {
      this.deps.logger?.warn("eval.try_session_cleanup_failed", safeMessage(err));
    }
  }

  async tryOne(input: TryOneInput): Promise<TryResult> {
    this.claim();
    this.reserved = false;
    this.trying = true;
    const evalRunId = `${EVAL_RUN_ID_PREFIX}${randomBytes(6).toString("hex")}`;
    this.tryingRunId = evalRunId;
    const abort = new AbortController();
    let hooked = false;
    let tried: { projectRoot: string; subjectRef: string } | undefined;
    try {
      const engine = this.engines(this.engineName);
      const engineInfo = { name: engine.name, version: await engine.version(), nodeVersion: process.versions.node };
      const evalText =
        input.definition === undefined
          ? undefined
          : typeof input.definition === "string"
            ? input.definition
            : stringifyYaml(input.definition);
      const built = await buildEvalPlan({
        projectRoot: input.projectRoot,
        evalPath: input.evalPath,
        ...(evalText !== undefined ? { evalText } : {}),
        ...(input.datasetCases !== undefined ? { datasetCases: input.datasetCases } : {}),
        overrides: {
          repeats: 1,
          ...(input.caseId !== undefined ? { case_ids: [input.caseId] } : {}),
          ...(input.allowRealTools === true ? { allow_real_tools: true } : {}),
        },
        evalRunId,
        engine: engineInfo,
        ...(this.deps.isKnownModel ? { isKnownModel: this.deps.isKnownModel } : {}),
        ...this.agentsInput(),
      });
      if (!built.ok) throw new EvalRunError("EVAL_INVALID", "Eval is invalid", built.findings);
      this.requireRealToolsConsent(built.plan, { allow_real_tools: input.allowRealTools === true });
      let plan: EvalPlan = built.plan;
      if (input.case !== undefined) {
        const c = input.case;
        const planCase: PlanCase = {
          id: c.id ?? "try",
          position: 0,
          input: c.input,
          tags: c.tags ?? [],
          ...(c.expected !== undefined ? { expected: c.expected } : {}),
          ...(c.title !== undefined ? { title: c.title } : {}),
          ...(c.goal !== undefined ? { goal: c.goal } : {}),
          ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
        };
        plan = { ...plan, cases: [planCase] };
      } else if (input.caseId === undefined || plan.cases.length !== 1) {
        throw new EvalRunError("EVAL_INVALID", "Try one case needs a case id or an inline case");
      }
      plan = { ...plan, repeats: 1 };

      let captured: NormalizedResult | undefined;
      const io = this.makeIo(
        plan,
        (r) => {
          captured ??= r;
        },
        () => undefined,
      );
      const { onRunStarted } = this.deps;
      if (onRunStarted) {
        hooked = true;
        await this.runHook("onRunStarted", () =>
          onRunStarted(evalRunId, { plan, engineName: engine.name, runCase: io.runCase, signal: abort.signal }),
        );
      }
      await engine.run(plan, io, abort.signal);
      if (captured === undefined) {
        throw new EvalRunError("EVAL_ENGINE_ERROR", "Engine finished without a result for this case");
      }
      const row = this.resultInput(plan, captured);
      if (plan.target.kind === "agent" && row.subjectRef) tried = { projectRoot: input.projectRoot, subjectRef: row.subjectRef };
      const grades: TryGrade[] = (row.grades ?? []).map((g) => ({
        graderId: g.graderId,
        graderType: g.graderType,
        status: g.status,
        passed: g.passed ?? null,
        score: g.score ?? null,
        rawValue: g.rawValue ?? null,
        reason: g.reason ?? null,
        errorCode: g.errorCode ?? null,
        details: g.details ?? null,
        judgeCostUsd: g.judgeCostUsd ?? null,
      }));
      return {
        result: {
          caseId: row.caseId,
          status: row.status,
          errorCode: row.errorCode ?? null,
          errorMessage: row.errorMessage ?? null,
          stageRunId: row.stageRunId ?? null,
          subjectRef: row.subjectRef ?? null,
          output: row.output ?? null,
          latencyMs: row.latencyMs ?? null,
          costUsd: row.costUsd ?? null,
          tokensIn: row.tokensIn ?? null,
          tokensOut: row.tokensOut ?? null,
          score: row.score ?? null,
          passed: row.passed ?? false,
          hasGraderErrors: row.hasGraderErrors ?? false,
          budgetWarnings: row.budgetWarnings ?? [],
          grades,
        },
        grades,
        stageRunId: row.stageRunId ?? null,
        costUsd: this.runner.spend(evalRunId),
      };
    } finally {
      await this.dropTrySession(tried);
      this.trying = false;
      this.tryingRunId = null;
      const { onRunFinished } = this.deps;
      if (hooked && onRunFinished) await this.runHook("onRunFinished", () => onRunFinished(evalRunId));
      await this.cleanupWorkDir(evalRunId);
    }
  }
}
