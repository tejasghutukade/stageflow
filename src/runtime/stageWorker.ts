import { resolveAgentPort } from "../agent/resolveAgentPort.js";
import { asAgentBackendId } from "../agent/agentBackend.js";
import { loadStageflowManifestOutcome } from "../config/loadStageflowManifest.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import { createRunStore } from "../runstore/createStore.js";
import { loadRunContext } from "./resumeReconstruct.js";
import {
  bindPiAgentDirEnv,
  rootsForStageWorker,
  withResolvedAuthPath,
} from "./stageRoots.js";
import {
  runStage,
  type RunStageOutcome,
  isRunStageWaiting,
} from "./stageRunner.js";
import { openStageAttempt } from "./stageAttemptBootstrap.js";
import { attemptContext } from "./stageAttemptContext.js";
import { loadActiveFeedbackLoopContext } from "./feedbackLoopCoordinator.js";
import {
  outcomeToWorkerResult,
  STAGE_WORKER_EXIT,
  type StageWorkerInput,
  type StageWorkerResult,
} from "./stageWorkerProtocol.js";

export type { StageWorkerInput, StageWorkerResult } from "./stageWorkerProtocol.js";

export async function runStageWorker(
  input: StageWorkerInput,
): Promise<RunStageOutcome> {
  const store = createRunStore({ rootDir: input.rootDir });
  const { meta, task, loaded } = await loadRunContext(
    store,
    input.runId,
    input.rootDir,
  );
  const definitionId = definitionIdForInstance(meta.pipeline_dag, input.stageId);
  const stage = loaded.stages.find((s) => s.id === definitionId);
  if (!stage) {
    return {
      ok: false,
      reason: `Stage ${input.stageId} not in pipeline ${meta.pipeline_id}`,
    };
  }

  const dag = meta.pipeline_dag ?? loaded.dag;

  const manifestOutcome = await loadStageflowManifestOutcome(input.rootDir);
  const agent = resolveAgentPort({
    global: manifestOutcome.ok
      ? asAgentBackendId(manifestOutcome.value.manifest.agent)
      : undefined,
    pipeline: asAgentBackendId(loaded.pipeline.agent),
    stage: asAgentBackendId(stage.agent),
  });
  const workspaceDir = store.getWorkspaceDir(input.runId);
  const checkoutRoot = meta.checkout_root;
  const mode = input.mode ?? "run";
  const attempt = input.attempt ?? 1;
  const attemptCtx =
    input.attempt !== undefined ? attemptContext(input.attempt) : undefined;
  const eventOptions = { attempt };
  const roots = withResolvedAuthPath(
    rootsForStageWorker(
      workspaceDir,
      input.stageId,
      stage.model!,
      checkoutRoot,
      attemptCtx,
    ),
    input.rootDir,
  );
  const unbindAgentDir = bindPiAgentDirEnv(roots.agentDir);

  try {
    if (mode === "resume") {
      const opened = await openStageAttempt({
        agent,
        store,
        runId: input.runId,
        stage,
        stageId: input.stageId,
        task,
        dag,
        checkoutRoot,
        workspaceDir,
        factoryCwd: input.rootDir,
        attemptCtx,
        operatorCatalog: input.operatorCatalog,
        roots,
        resumeToken: input.sessionFilePath,
        sessionMode: "waiting_resume",
        onActivity: (event) => {
          void store.appendStageEvent(
            input.runId,
            input.stageId,
            event,
            eventOptions,
          );
        },
      });
      if (!opened.ok) {
        return { ok: false, reason: opened.reason };
      }
      opened.handle.deliverAnswer(input.resumeAnswer);
      const outcome = await runStage({
        agent,
        store,
        runId: input.runId,
        stage,
        stageId: input.stageId,
        task,
        dag,
        checkoutRoot,
        workspaceDir,
        skipStarted: true,
        existingHandle: opened.handle,
        workerMode: true,
        roots,
        attemptCtx,
        factoryCwd: input.rootDir,
        operatorCatalog: input.operatorCatalog,
        skipGates: input.skipGates,
      });
      return outcome;
    }

    if (mode === "feedback_resume" || mode === "new_session") {
      const feedbackLoopContext = await loadActiveFeedbackLoopContext(
        store,
        input.runId,
        input.stageId,
      );
      if (mode === "feedback_resume" && feedbackLoopContext === undefined) {
        return {
          ok: false,
          reason: "feedback_resume requires an active feedback-loop context",
        };
      }
      const priorAttempt = feedbackLoopContext?.prior_stage_attempt;
      const resumeToken =
        input.sessionFilePath ??
        (mode === "feedback_resume" && priorAttempt !== undefined
          ? attemptContext(priorAttempt).sessionPath(workspaceDir, input.stageId)
          : undefined);
      const opened = await openStageAttempt({
        agent,
        store,
        runId: input.runId,
        stage,
        stageId: input.stageId,
        task,
        dag,
        checkoutRoot,
        workspaceDir,
        factoryCwd: input.rootDir,
        attemptCtx,
        operatorCatalog: input.operatorCatalog,
        roots,
        ...(resumeToken !== undefined ? { resumeToken } : {}),
        sessionMode: mode,
        ...(feedbackLoopContext !== undefined ? { feedbackLoopContext } : {}),
        onActivity: (event) => {
          void store.appendStageEvent(
            input.runId,
            input.stageId,
            event,
            eventOptions,
          );
        },
      });
      if (!opened.ok) {
        return { ok: false, reason: opened.reason };
      }
      return runStage({
        agent,
        store,
        runId: input.runId,
        stage,
        stageId: input.stageId,
        task,
        dag,
        checkoutRoot,
        workspaceDir,
        existingHandle: opened.handle,
        workerMode: true,
        roots,
        attemptCtx,
        factoryCwd: input.rootDir,
        operatorCatalog: input.operatorCatalog,
        skipGates: input.skipGates,
      });
    }

    return runStage({
      agent,
      store,
      runId: input.runId,
      stage,
      stageId: input.stageId,
      task,
      dag,
      checkoutRoot,
      workspaceDir,
      workerMode: true,
      roots,
      attemptCtx,
      factoryCwd: input.rootDir,
      operatorCatalog: input.operatorCatalog,
      skipGates: input.skipGates,
    });
  } finally {
    unbindAgentDir();
  }
}

export function sendWorkerResult(result: StageWorkerResult): void {
  if (typeof process.send === "function") {
    process.send(result);
  }
}

export function exitForOutcome(outcome: RunStageOutcome): never {
  const message = outcomeToWorkerResult(outcome);
  sendWorkerResult(message);
  if (isRunStageWaiting(outcome)) {
    process.exit(STAGE_WORKER_EXIT.WAITING);
  }
  if (outcome.ok) {
    process.exit(STAGE_WORKER_EXIT.SUCCEEDED);
  }
  process.exit(STAGE_WORKER_EXIT.FAILED);
}
