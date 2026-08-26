import { PiAgentAdapter } from "../agent/piAdapter.js";
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
  const stage = loaded.stages.find((s) => s.id === input.stageId);
  if (!stage) {
    return {
      ok: false,
      reason: `Stage ${input.stageId} not in pipeline ${meta.pipeline_id}`,
    };
  }

  const agent = new PiAgentAdapter();
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
      stage.model,
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
        task,
        dag: loaded.dag,
        checkoutRoot,
        workspaceDir,
        factoryCwd: input.rootDir,
        attemptCtx,
        operatorCatalog: input.operatorCatalog,
        roots,
        resumeToken: input.sessionFilePath,
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
        task,
        dag: loaded.dag,
        checkoutRoot,
        workspaceDir,
        skipStarted: true,
        existingHandle: opened.handle,
        roots,
        attemptCtx,
        factoryCwd: input.rootDir,
        operatorCatalog: input.operatorCatalog,
        skipGates: input.skipGates,
      });
      return outcome;
    }

    return runStage({
      agent,
      store,
      runId: input.runId,
      stage,
      task,
      dag: loaded.dag,
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
