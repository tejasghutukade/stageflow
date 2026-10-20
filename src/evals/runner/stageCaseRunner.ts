import path from "node:path";
import { isStageTimeoutReason } from "../../agent/stageTimeout.js";
import { loadPipelineOutcome } from "../../config/loadPipeline.js";
import { readYamlObject } from "../../config/readYamlObject.js";
import { projectRunForMcp } from "../../mcp/projectRun.js";
import { isWaitingProjection } from "../../mcp/waitRun.js";
import type { RunStore, StageSnapshot } from "../../runstore/port.js";
import { PipelineValidationError } from "../../runtime/pipelineValidationError.js";
import type { RunManager } from "../../runtime/runManager.js";
import type { InlinePipelineDefinition } from "../../types/pipeline.js";
import type { StageUsage } from "../../types/usage.js";
import { caseToTask } from "../caseTask.js";
import type { CaseOutput, EvalPlan, RunCaseFailureCode, RunCaseRequest, RunCaseResult } from "../types.js";

export const EVAL_STAGE_TIMEOUT_GRACE_MS = 60_000;
export const EVAL_STAGE_DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const EVAL_RUNNER_POLL_INTERVAL_MS = 250;
export const EVAL_RUNNER_BUSY_BACKOFF_MS = { initial: 1_000, max: 5_000 } as const;

export type StageCaseRunnerDeps = {
  manager: Pick<RunManager, "startRun" | "cancelRun">;
  store: Pick<RunStore, "readRun" | "listStageExecutions">;
  pollIntervalMs?: number;
  busyBackoffMs?: { initial: number; max: number };
  timeoutGraceMs?: number;
  defaultTimeoutMs?: number;
};

export interface StageCaseRunner {
  runCase(plan: EvalPlan, req: RunCaseRequest): Promise<RunCaseResult>;
  cancelAll(evalRunId: string): Promise<void>;
  spend(evalRunId: string): number;
  addSpend(evalRunId: string, usd: number): void;
}

type StopReason = "needs_input" | "timeout" | "cancelled";

type EvalRunState = {
  active: Map<string, { done: Promise<unknown> }>;
  stops: Map<string, StopReason>;
  spend: number;
  cancelled: boolean;
  abort: AbortController;
};

type StageBody = { body: Record<string, unknown>; stageId: string };

class EngineError extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function readStageBody(plan: EvalPlan): Promise<StageBody> {
  const { target, projectRoot } = plan;
  const abs = (rel: string): string => path.resolve(projectRoot, rel);
  let body: Record<string, unknown> | undefined;
  let stageId: string | undefined;

  if (target.file !== undefined) {
    body = await readYamlObject(abs(target.file));
    stageId = typeof body.id === "string" ? body.id : undefined;
  } else if (target.pipelinePath !== undefined && target.stageId !== undefined) {
    stageId = target.stageId;
    const pipelineAbs = abs(target.pipelinePath);
    const loaded = await loadPipelineOutcome(pipelineAbs, { cwd: projectRoot, projectRoot, requireIo: false });
    if (!loaded.ok) throw new EngineError(`Target pipeline ${target.pipelinePath} does not load`);
    const source = loaded.value.stageSources?.[stageId];
    if (source?.kind === "file") {
      body = await readYamlObject(source.path);
    } else {
      const raw = await readYamlObject(pipelineAbs);
      const entries = Array.isArray(raw.stages) ? (raw.stages as unknown[]) : [];
      const entry = entries.find(
        (e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null && (e as Record<string, unknown>).id === stageId,
      );
      if (entry !== undefined) {
        const { needs: _needs, route: _route, route_if: _routeIf, entry: _entry, ...rest } = entry;
        body = rest;
      }
    }
  }
  if (body === undefined || stageId === undefined) {
    throw new EngineError("Target stage could not be read");
  }
  return { body: { ...body, id: stageId }, stageId };
}

function sumTokens(usage: StageUsage | undefined): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const model of Object.values(usage?.models ?? {})) {
    tokensIn += model.inputTokens;
    tokensOut += model.outputTokens;
  }
  return { tokensIn, tokensOut };
}

function failure(
  code: RunCaseFailureCode,
  message: string,
  extra: { stageRunId?: string; latencyMs?: number; costUsd?: number } = {},
): RunCaseResult {
  return {
    ok: false,
    code,
    message,
    ...(extra.stageRunId !== undefined ? { stageRunId: extra.stageRunId } : {}),
    ...(extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
    ...(extra.costUsd !== undefined ? { costUsd: extra.costUsd } : {}),
  };
}

export function createStageCaseRunner(deps: StageCaseRunnerDeps): StageCaseRunner {
  const { manager, store } = deps;
  const pollMs = deps.pollIntervalMs ?? EVAL_RUNNER_POLL_INTERVAL_MS;
  const backoff = deps.busyBackoffMs ?? EVAL_RUNNER_BUSY_BACKOFF_MS;
  const graceMs = deps.timeoutGraceMs ?? EVAL_STAGE_TIMEOUT_GRACE_MS;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? EVAL_STAGE_DEFAULT_TIMEOUT_MS;
  const states = new Map<string, EvalRunState>();

  const stateFor = (evalRunId: string): EvalRunState => {
    let state = states.get(evalRunId);
    if (state === undefined) {
      state = { active: new Map(), stops: new Map(), spend: 0, cancelled: false, abort: new AbortController() };
      states.set(evalRunId, state);
    }
    return state;
  };

  async function cancelStageRun(state: EvalRunState, runId: string, reason: StopReason): Promise<void> {
    if (!state.stops.has(runId)) state.stops.set(runId, reason);
    await manager.cancelRun(runId, `eval_${reason}`).catch(() => undefined);
  }

  async function startWithRetry(
    state: EvalRunState,
    input: Parameters<RunManager["startRun"]>[0],
  ): Promise<Awaited<ReturnType<RunManager["startRun"]>>> {
    let delay = backoff.initial;
    for (;;) {
      const started = await manager.startRun(input);
      if (started.ok || started.code !== "busy_capacity" || state.cancelled) return started;
      await sleep(delay, state.abort.signal);
      if (state.cancelled) return started;
      delay = Math.min(delay * 2, backoff.max);
    }
  }

  async function awaitRun(
    state: EvalRunState,
    runId: string,
    done: Promise<unknown>,
    timeoutMs: number,
  ): Promise<void> {
    let stop = false;
    const wakeUp = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const settled = done.then(
      () => "done" as const,
      () => "done" as const,
    );
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const waiting = (async (): Promise<"waiting" | "stopped"> => {
      while (!stop) {
        await sleep(pollMs, wakeUp.signal);
        if (stop) break;
        try {
          const detail = await store.readRun(runId);
          if (detail.status === "running" && isWaitingProjection(projectRunForMcp(detail))) return "waiting";
        } catch {
          /* run row not readable yet; retry on next tick */
        }
      }
      return "stopped";
    })();

    try {
      const wake = await Promise.race([settled, timedOut, waiting]);
      if (wake === "waiting") await cancelStageRun(state, runId, "needs_input");
      else if (wake === "timeout") await cancelStageRun(state, runId, "timeout");
      await settled;
    } finally {
      stop = true;
      wakeUp.abort();
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function collect(
    state: EvalRunState,
    runId: string,
    stageId: string,
    fallbackLatencyMs: number,
  ): Promise<RunCaseResult> {
    const detail = await store.readRun(runId);
    const stage: StageSnapshot | undefined = detail.stages.find((s) => s.stage_id === stageId) ?? detail.stages[0];
    const costUsd = stage?.cost_usd ?? stage?.usage?.costUsd ?? detail.total_cost_usd ?? 0;
    let latencyMs = fallbackLatencyMs;
    try {
      const executions = await store.listStageExecutions(runId, stage?.stage_id ?? stageId);
      const latest = executions[executions.length - 1];
      if (latest?.started_at !== undefined && latest.finished_at !== undefined) {
        latencyMs = Math.max(0, Date.parse(latest.finished_at) - Date.parse(latest.started_at));
      }
    } catch {
      /* keep wall-clock fallback */
    }
    const extra = { stageRunId: runId, latencyMs, costUsd };
    state.spend += costUsd;

    if (detail.status === "cancelled") {
      const reason = state.stops.get(runId) ?? "cancelled";
      if (reason === "needs_input") {
        return failure("EVAL_STAGE_NEEDS_INPUT", "Stage stopped to ask the operator for input", extra);
      }
      if (reason === "timeout") {
        return failure("EVAL_STAGE_TIMEOUT", "Stage exceeded the eval safety timeout", extra);
      }
      return failure("EVAL_CANCELLED", "Eval run was cancelled", extra);
    }
    if (detail.status === "failed") {
      const reason = detail.failed_reason ?? "Stage failed";
      return failure(isStageTimeoutReason(reason) ? "EVAL_STAGE_TIMEOUT" : "EVAL_STAGE_FAILED", reason, extra);
    }
    if (detail.status !== "succeeded") {
      return failure("EVAL_ENGINE_ERROR", `Stage run ended in unexpected state "${detail.status}"`, extra);
    }
    const envelope = stage?.envelope;
    if (!envelope) return failure("EVAL_ENGINE_ERROR", "Stage run finished without an envelope", extra);
    const output: CaseOutput = {
      kind: "envelope",
      status: envelope.status === "success" ? "success" : "failure",
      summary: envelope.summary,
      ...(envelope.payload !== undefined ? { payload: envelope.payload } : {}),
      artifacts: envelope.artifacts ?? [],
    };
    const { tokensIn, tokensOut } = sumTokens(stage?.usage);
    return { ok: true, stageRunId: runId, output, latencyMs, costUsd, tokensIn, tokensOut };
  }

  async function runCase(plan: EvalPlan, req: RunCaseRequest): Promise<RunCaseResult> {
    const state = stateFor(req.evalRunId);
    if (state.cancelled) return failure("EVAL_CANCELLED", "Eval run was cancelled");
    if (state.spend >= plan.maxCostUsd) {
      return failure("EVAL_BUDGET_EXCEEDED", `Eval spend reached the $${plan.maxCostUsd} limit`);
    }
    const planCase = plan.cases.find((c) => c.id === req.caseId);
    if (planCase === undefined) return failure("EVAL_ENGINE_ERROR", `Case "${req.caseId}" is not in the plan`);

    let stageBody: StageBody;
    try {
      stageBody = await readStageBody(plan);
    } catch (err) {
      return failure("EVAL_ENGINE_ERROR", err instanceof Error ? err.message : "Target stage could not be read");
    }
    const { body, stageId } = stageBody;
    const pipeline: InlinePipelineDefinition = {
      id: `standalone-${stageId}`,
      stages: [{ ...body, model: plan.modelOverride ?? plan.stageModel }],
    };
    const task = caseToTask(plan, planCase, req.evalRunId, req.repeatIndex);

    const startedAt = Date.now();
    let started;
    try {
      started = await startWithRetry(state, { pipeline, task, projectRoot: plan.projectRoot, origin: "eval" });
    } catch (err) {
      if (err instanceof PipelineValidationError) {
        const first = err.result.findings.find((f) => f.severity === "error") ?? err.result.findings[0];
        return failure("EVAL_ENGINE_ERROR", first?.message ?? "Stage validation failed");
      }
      return failure("EVAL_ENGINE_ERROR", err instanceof Error ? err.message : "Stage run could not start");
    }
    if (!started.ok) {
      if (state.cancelled) return failure("EVAL_CANCELLED", "Eval run was cancelled");
      return failure("EVAL_ENGINE_ERROR", started.reason);
    }

    const { runId, done } = started;
    state.active.set(runId, { done });
    try {
      if (state.cancelled) await cancelStageRun(state, runId, "cancelled");
      const declared = typeof body.timeout_ms === "number" ? body.timeout_ms : undefined;
      const timeoutMs = declared !== undefined ? declared + graceMs : defaultTimeoutMs;
      await awaitRun(state, runId, done, timeoutMs);
      return await collect(state, runId, stageId, Date.now() - startedAt);
    } catch (err) {
      return failure("EVAL_ENGINE_ERROR", err instanceof Error ? err.message : "Stage run failed", {
        stageRunId: runId,
      });
    } finally {
      state.active.delete(runId);
      state.stops.delete(runId);
    }
  }

  return {
    runCase,
    async cancelAll(evalRunId) {
      const state = stateFor(evalRunId);
      state.cancelled = true;
      state.abort.abort();
      await Promise.all(
        [...state.active.entries()].map(async ([runId, entry]) => {
          await cancelStageRun(state, runId, "cancelled");
          await Promise.resolve(entry.done).catch(() => undefined);
        }),
      );
    },
    spend: (evalRunId) => states.get(evalRunId)?.spend ?? 0,
    addSpend(evalRunId, usd) {
      stateFor(evalRunId).spend += usd;
    },
  };
}
