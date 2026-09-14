import { existsSync } from "node:fs";
import type { AgentPort } from "../agent/port.js";
import { fakeHitlResumePath } from "../agent/fakeAgent.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { RunStore } from "../runstore/port.js";
import { attemptSessionPath } from "../runstore/workspaceLayout.js";
import { WAIT_WITHOUT_WORKER_DISPATCH } from "./answerResume.js";
import { resumeRun } from "./pipelineScheduler.js";
import { loadRunContext } from "./resumeReconstruct.js";
import type { StageExecutionMode } from "./stageConcurrency.js";
import type { StageProcessLauncher } from "./stageProcessLauncher.js";
import { StageHitlController } from "./stageHitl.js";
import { isRunStageWaiting, runStage } from "./stageRunner.js";
import { attemptContext } from "./stageAttemptContext.js";
import {
  openStageAttempt,
  type OperatorCatalog,
} from "./stageAttemptBootstrap.js";
import { buildStageRoots, withResolvedAuthPath } from "./stageRoots.js";
import {
  isStageTimeoutReason,
  lastFailedReason,
} from "../agent/stageTimeout.js";
import { deriveExecutionPatchFromEvent } from "../runstore/stageExecution.js";

export type ResumeTimedOutContext = {
  runId: string;
  stageId: string;
  agent: AgentPort;
  store: RunStore;
  hitl: StageHitlController;
  executionMode: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  cwd: string;
  factoryCwd?: string;
  maxActiveStagesPerRun: number;
  operatorCatalog?: OperatorCatalog;
};

export function assertTimedOutStageEligible(
  status: string,
  events: ReadonlyArray<{ event: string; reason?: string }>,
): { ok: true } | { ok: false; reason: string; status: 409 } {
  if (status !== "failed") {
    return {
      ok: false,
      reason: `Stage is not timed out (status=${status})`,
      status: 409,
    };
  }
  if (!isStageTimeoutReason(lastFailedReason(events))) {
    return {
      ok: false,
      reason: "Stage did not fail due to timeout; use retry to start a new attempt",
      status: 409,
    };
  }
  return { ok: true };
}

export async function reconstructTimedOutAndContinue(
  ctx: ResumeTimedOutContext,
): Promise<{ ok: boolean; reason?: string }> {
  const { runId, stageId, agent, store, cwd } = ctx;
  const factoryCwd = ctx.factoryCwd ?? cwd;

  try {
    const latestExecution = await store.getLatestStageExecution(runId, stageId);
    const attempt = latestExecution?.attempt ?? 1;
    const attemptCtx = attemptContext(attempt);
    const attemptOpt = attemptCtx.eventOptions();

    const { meta, task, loaded } = await loadRunContext(store, runId, cwd);
    const definitionId = definitionIdForInstance(meta.pipeline_dag, stageId);
    const stageIndex = loaded.stages.findIndex((s) => s.id === definitionId);
    if (stageIndex < 0) {
      const reason = `Stage ${stageId} not in pipeline ${meta.pipeline_id}`;
      await store.appendStageEvent(
        runId,
        stageId,
        { event: "failed", reason },
        attemptOpt,
      );
      await store.updateRunStatus(runId, "failed");
      return { ok: false, reason };
    }
    const stage = loaded.stages[stageIndex]!;
    const dag = meta.pipeline_dag ?? loaded.dag;
    const workspaceDir = store.getWorkspaceDir(runId);
    const checkoutRoot = meta.checkout_root;
    const roots = withResolvedAuthPath(
      buildStageRoots(workspaceDir, stageId, checkoutRoot, attemptCtx),
      factoryCwd,
    );

    const sessionFile = attemptSessionPath(workspaceDir, stageId, attempt);
    const fakeResume = fakeHitlResumePath(roots, stageId);
    if (!existsSync(sessionFile) && !existsSync(fakeResume)) {
      return {
        ok: false,
        reason: "missing session to resume; use retry to start a new attempt",
      };
    }

    const resumed = { event: "resumed" as const };
    await store.appendStageEvent(runId, stageId, resumed, attemptOpt);
    try {
      const execution = await store.getStageExecution(runId, stageId, attempt);
      const patch = deriveExecutionPatchFromEvent(resumed, execution);
      if (Object.keys(patch).length > 0) {
        await store.updateStageExecution(runId, stageId, attempt, patch);
      }
    } catch {
      // no execution row yet
    }
    await store.updateRunStatus(runId, "running");

    const opened = await openStageAttempt({
      agent,
      store,
      runId,
      stage,
      stageId,
      task,
      dag,
      checkoutRoot,
      workspaceDir,
      factoryCwd,
      attemptCtx,
      operatorCatalog: ctx.operatorCatalog,
      sessionMode: "timeout_resume",
      resumeToken: sessionFile,
      onActivity: (event) => {
        void store.appendStageEvent(runId, stageId, event, attemptOpt);
      },
    });
    if (!opened.ok) {
      await store.appendStageEvent(
        runId,
        stageId,
        { event: "failed", reason: opened.reason },
        attemptOpt,
      );
      await store.updateRunStatus(runId, "failed");
      return { ok: false, reason: opened.reason };
    }

    const result = await runStage({
      agent,
      store,
      runId,
      stage,
      stageId,
      task,
      dag,
      checkoutRoot,
      workspaceDir,
      hitl: ctx.hitl,
      skipStarted: true,
      existingHandle: opened.handle,
      attemptCtx,
      factoryCwd,
      operatorCatalog: ctx.operatorCatalog,
      sessionMode: "timeout_resume",
      resumeToken: sessionFile,
    });

    if (isRunStageWaiting(result)) {
      await store.updateRunStatus(runId, "failed");
      return {
        ok: false,
        reason: WAIT_WITHOUT_WORKER_DISPATCH,
      };
    }

    if (!result.ok) {
      await store.updateRunStatus(runId, "failed");
      return { ok: false, reason: result.reason };
    }

    const rest = await resumeRun({
      prepared: {
        task,
        loaded,
        run: { runId, workspaceDir },
        agent,
        store,
        cwd,
        projectRoot: factoryCwd,
        checkoutRoot,
        hitl: ctx.hitl,
        operatorCatalog: ctx.operatorCatalog,
      },
      maxActiveStagesPerRun: ctx.maxActiveStagesPerRun,
      resumeFromStageId: stageId,
      initialPrior: result.envelope ?? null,
      executionMode: ctx.executionMode,
      stageProcessLauncher: ctx.stageProcessLauncher,
    });
    if (rest.outcome === "failed") {
      return { ok: false, reason: rest.reason };
    }
    return { ok: true };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : `timeout resume failed: ${String(err)}`;
    try {
      const latestExecution = await store.getLatestStageExecution(runId, stageId);
      const attemptCtx = attemptContext(latestExecution?.attempt ?? 1);
      await store.appendStageEvent(
        runId,
        stageId,
        { event: "failed", reason },
        attemptCtx.eventOptions(),
      );
      await store.updateRunStatus(runId, "failed");
    } catch {
      // ignore secondary failures
    }
    return { ok: false, reason };
  }
}
