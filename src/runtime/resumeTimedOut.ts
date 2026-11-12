import { existsSync } from "node:fs";
import type { StagePort } from "../agent/port.js";
import { fakeHitlResumePath } from "../agent/fakeAgent.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { RunStore } from "../runstore/port.js";
import { attemptSessionPath } from "../runstore/workspaceLayout.js";
import {
  defaultStageBrowserSupport,
  resolveStageBrowserEnv,
} from "../browser/stageBrowserEnv.js";
import type { StageBrowserSupport } from "../browser/browserHost.js";
import { runOwnerScope } from "../browser/ownerScope.js";
import { isHumanLoginStage } from "../browser/humanLogin.js";
import { createRunLiveness } from "../browser/runLiveness.js";
import { acquireStageProfile } from "../browser/stageProfileLock.js";
import { teardownStageBrowser } from "../browser/browserTeardown.js";
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
import { buildStageRoots, stageBindingEnvFromRun, withResolvedAuthPath } from "./stageRoots.js";
import {
  prepareResumeAttemptHome,
  secretUnavailableMessage,
} from "./resumeAttemptPrep.js";
import type { StageEnvelope } from "../types/envelope.js";
import {
  isStageTimeoutReason,
  lastFailedReason,
} from "../agent/stageTimeout.js";
import { deriveExecutionPatchFromEvent } from "../runstore/stageExecution.js";

export type ResumeTimedOutContext = {
  runId: string;
  stageId: string;
  agent: StagePort;
  store: RunStore;
  hitl: StageHitlController;
  executionMode: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  cwd: string;
  factoryCwd?: string;
  maxActiveStagesPerRun: number;
  operatorCatalog?: OperatorCatalog;
  browser?: StageBrowserSupport;
};

export function assertResumableStage(
  status: string,
  events: ReadonlyArray<{ event: string; reason?: string }>,
): { ok: true } | { ok: false; reason: string; status: 409 } {
  if (status === "interrupted") {
    return { ok: true };
  }
  if (status !== "failed") {
    return {
      ok: false,
      reason: `Stage is not resumable (status=${status})`,
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

  async function continueAfterStageSuccess(
    resultEnvelope: StageEnvelope | undefined,
  ): Promise<{ ok: boolean; reason?: string }> {
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
        ...(ctx.browser !== undefined ? { browser: ctx.browser } : {}),
      },
      maxActiveStagesPerRun: ctx.maxActiveStagesPerRun,
      resumeFromStageId: stageId,
      initialPrior: resultEnvelope ?? null,
      executionMode: ctx.executionMode,
      stageProcessLauncher: ctx.stageProcessLauncher,
    });
    if (rest.outcome === "failed") {
      return { ok: false, reason: rest.reason };
    }
    return { ok: true };
  }

    if (ctx.executionMode === "process") {
      const launcher = ctx.stageProcessLauncher;
      if (!launcher) {
        const reason = "stage process launcher is not configured";
        await store.appendStageEvent(
          runId,
          stageId,
          { event: "failed", reason },
          attemptOpt,
        );
        await store.updateRunStatus(runId, "failed");
        return { ok: false, reason };
      }
      const browser = ctx.browser ?? defaultStageBrowserSupport();
      let prep;
      try {
        prep = await prepareResumeAttemptHome({
          workspaceDir,
          stageId,
          attempt,
          secrets: stage.secrets,
          hostEnv: process.env,
          logContext: { run_id: runId, stage_id: stageId },
        });
      } catch (err) {
        const reason = secretUnavailableMessage(err);
        await store.appendStageEvent(
          runId,
          stageId,
          { event: "failed", reason },
          attemptOpt,
        );
        await store.updateRunStatus(runId, "failed");
        return { ok: false, reason };
      }

      const stageBinding = stageBindingEnvFromRun({
        meta,
        task,
        runWorkspaceDir: workspaceDir,
        hostEnv: process.env,
      });

      try {
        if (stage.browser?.profile !== undefined) {
          const acquired = await acquireStageProfile(browser, {
            scope: runOwnerScope(browser, { runId }),
            profile: stage.browser.profile,
            owner: { runId, stageId },
            isRunLive: createRunLiveness(store),
            halted: () => true,
          });
          if (acquired === "halted") {
            throw new Error(
              `browser profile "${stage.browser.profile}" is held by another run`,
            );
          }
        }
        let browserEnv: Record<string, string> | undefined;
        try {
          browserEnv = await resolveStageBrowserEnv(browser, {
            runId,
            stageId,
            scope: runOwnerScope(browser, { runId }),
            runDir: workspaceDir,
            browser: stage.browser,
            attempt,
            humanLogin: isHumanLoginStage(dag, definitionId, stage.browser),
            resuming: true,
          });
        } catch (err) {
          prep.cleanup();
          throw err;
        }

        const launchResult = await launcher
          .launch({
            runId,
            stageId,
            rootDir: factoryCwd,
            factoryCwd,
            stage,
            workspaceDir,
            ...(browserEnv !== undefined ? { browserEnv } : {}),
            mode: "timeout_resume",
            attempt,
            sessionFilePath: sessionFile,
            env: stageBinding.env,
            bindingKind: stageBinding.kind,
            grants: prep.grants,
            attemptHome: prep.attemptHome,
            model: stage.model,
            ...(ctx.operatorCatalog !== undefined
              ? { operatorCatalog: ctx.operatorCatalog }
              : {}),
          })
          .finally(() => {
            prep.cleanup();
          });

        if (launchResult.type === "waiting") {
          return { ok: true };
        }

        await teardownStageBrowser(browser, {
          runId,
          runDir: workspaceDir,
          stageId,
          events: () => store.listStageEvents(runId, stageId),
        }).catch(() => undefined);

        if (launchResult.type === "failed") {
          const recorded = await store.listStageEvents(runId, stageId, attempt);
          if (!recorded.some((event) => event.event === "failed")) {
            await store.appendStageEvent(
              runId,
              stageId,
              { event: "failed", reason: launchResult.reason },
              attemptOpt,
            );
          }
          await store.updateRunStatus(runId, "failed");
          return { ok: false, reason: launchResult.reason };
        }

        let initialPrior: StageEnvelope | null = null;
        try {
          initialPrior = await store.readEnvelope(runId, stageId);
        } catch {
          // downstream resume may read envelope from store
        }
        return continueAfterStageSuccess(initialPrior ?? undefined);
      } catch (err) {
        prep.cleanup();
        throw err;
      }
    }

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

    return continueAfterStageSuccess(result.envelope);
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
