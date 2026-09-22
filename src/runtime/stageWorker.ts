import { resolveAgentPort } from "../agent/resolveAgentPort.js";
import { asAgentBackendId } from "../agent/agentBackend.js";
import { loadStageflowManifestOutcome } from "../config/loadStageflowManifest.js";
import { loadNamedSecretsFromAttemptDir } from "../logging/namedSecrets.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import { attemptWorkspaceDir } from "../runstore/workspaceLayout.js";
import { createRunStore } from "../runstore/createStore.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { loadRunContext } from "./resumeReconstruct.js";
import {
  bindPiAgentDirEnv,
  rootsForStageWorker,
  stageBindingEnvFromRun,
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

function applyStageEnvToWorkerProcess(
  env: Record<string, string>,
  kind: "repository" | "checkout" | "unbound",
): void {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  if (kind !== "repository") {
    delete process.env.STAGEFLOW_REPOSITORY;
    delete process.env.STAGEFLOW_REF;
    delete process.env.STAGEFLOW_BASE_SHA;
    delete process.env.STAGEFLOW_RUN_BRANCH;
  }
  if (kind === "unbound" || !Object.hasOwn(env, "STAGEFLOW_CHECKOUT")) {
    delete process.env.STAGEFLOW_CHECKOUT;
  }
  if (!Object.hasOwn(env, "GIT_CONFIG_COUNT")) {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  }
}

function curatedWorkerStageEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function runStageWorker(
  input: StageWorkerInput,
): Promise<RunStageOutcome> {
  const store = createRunStore({ rootDir: globalStageflowHome() });
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
  const binding =
    input.env !== undefined
      ? {
          env: input.env,
          kind: input.bindingKind ?? "unbound",
        }
      : stageBindingEnvFromRun({
          meta,
          task,
          runWorkspaceDir: workspaceDir,
          hostEnv: process.env,
        });
  applyStageEnvToWorkerProcess(binding.env, binding.kind);
  const stageEnv = curatedWorkerStageEnv();
  const mode = input.mode ?? "run";
  const attempt = input.attempt ?? 1;
  loadNamedSecretsFromAttemptDir(
    attemptWorkspaceDir(workspaceDir, input.stageId, attempt),
  );
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
        stageEnv,
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
        stageEnv,
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
        stageEnv,
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
        stageEnv,
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
      stageEnv,
    });
  } finally {
    unbindAgentDir();
  }
}

export function sendWorkerResult(result: StageWorkerResult): Promise<void> {
  if (typeof process.send !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const ok = process.send!(result, (err) => {
        void err;
        resolve();
      });
      if (ok === false) {
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

export function exitCodeForOutcome(outcome: RunStageOutcome): number {
  if (isRunStageWaiting(outcome)) {
    return STAGE_WORKER_EXIT.WAITING;
  }
  if (outcome.ok) {
    return STAGE_WORKER_EXIT.SUCCEEDED;
  }
  return STAGE_WORKER_EXIT.FAILED;
}

export async function exitForOutcome(outcome: RunStageOutcome): Promise<number> {
  const message = outcomeToWorkerResult(outcome);
  await sendWorkerResult(message);
  return exitCodeForOutcome(outcome);
}
