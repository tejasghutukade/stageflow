import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AgentPort, OpaqueAnswer } from "../agent/port.js";
import { fakeHitlResumePath } from "../agent/fakeAgent.js";
import { loadTaskFromYaml } from "../config/loadTask.js";
import { normalizeCatalogPath } from "../runstore/normalizeCatalogPath.js";
import {
  reloadPipelineForRun,
  reloadTaskForRun,
} from "./reloadRunCatalog.js";
import type { RunStore, RunMeta } from "../runstore/port.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { LoadedPipeline } from "../types/pipeline.js";
import type { TaskFile } from "../types/task.js";
import { WAIT_WITHOUT_WORKER_DISPATCH } from "./answerResume.js";
import { resumeRun } from "./pipelineScheduler.js";
import type { StageExecutionMode } from "./stageConcurrency.js";
import type { StageProcessLauncher } from "./stageProcessLauncher.js";
import { StageHitlController } from "./stageHitl.js";
import { buildStageRoots, withResolvedAuthPath } from "./stageRoots.js";
import { runStage, isRunStageWaiting } from "./stageRunner.js";
import { attemptContext } from "./stageAttemptContext.js";
import {
  openStageAttempt,
  type OperatorCatalog,
} from "./stageAttemptBootstrap.js";

export type PreparedResumeContext = {
  runId: string;
  stageId: string;
  opaqueAnswer: OpaqueAnswer;
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

export type LoadedRunContext = {
  meta: RunMeta;
  taskYaml: string;
  task: TaskFile;
  loaded: LoadedPipeline;
  workspaceDir: string;
};

export async function loadRunContext(
  store: RunStore,
  runId: string,
  cwd: string,
): Promise<LoadedRunContext> {
  const meta = await store.readRunMeta(runId);
  const reloadMeta: RunMeta = {
    ...meta,
    project_root: meta.project_root ?? normalizeCatalogPath(cwd),
  };
  const loaded = await reloadPipelineForRun(reloadMeta);
  let taskYaml: string;
  let task: TaskFile;
  if (meta.task_path) {
    task = await reloadTaskForRun(meta);
    taskYaml = await readFile(normalizeCatalogPath(meta.task_path), "utf8");
  } else {
    taskYaml = await store.readTaskYaml(runId);
    task = loadTaskFromYaml(taskYaml, `run ${runId} task`);
  }
  const workspaceDir = store.getWorkspaceDir(runId);
  return { meta, taskYaml, task, loaded, workspaceDir };
}

export async function reconstructAndContinue(
  ctx: PreparedResumeContext,
): Promise<{ ok: boolean; reason?: string }> {
  const { runId, stageId, opaqueAnswer, agent, store, cwd } = ctx;
  const factoryCwd = ctx.factoryCwd ?? cwd;

  try {
    const latestExecution = await store.getLatestStageExecution(runId, stageId);
    const attemptCtx = attemptContext(latestExecution?.attempt ?? 1);
    const attemptOpt = attemptCtx.eventOptions();

    const { meta, task, loaded } = await loadRunContext(store, runId, cwd);
    const definitionId = definitionIdForInstance(meta.pipeline_dag, stageId);
    const stageIndex = loaded.stages.findIndex((s) => s.id === definitionId);
    if (stageIndex < 0) {
      const reason = `Stage ${stageId} not in pipeline ${meta.pipeline_id}`;
      await store.appendStageEvent(
        runId,
        stageId,
        {
          event: "failed",
          reason,
        },
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
      buildStageRoots(
        workspaceDir,
        stageId,
        checkoutRoot,
        attemptCtx,
      ),
      factoryCwd,
    );

    const fakeResume = fakeHitlResumePath(roots, stageId);
    const piSession = attemptCtx.sessionPath(workspaceDir, stageId);
    if (!existsSync(fakeResume) && !existsSync(piSession)) {
      const reason = "missing resume context for waiting stage";
      await store.appendStageEvent(
        runId,
        stageId,
        {
          event: "failed",
          reason,
        },
        attemptOpt,
      );
      await store.updateRunStatus(runId, "failed");
      return { ok: false, reason };
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
      onActivity: (event) => {
        void store.appendStageEvent(runId, stageId, event, attemptOpt);
      },
    });
    if (!opened.ok) {
      await store.appendStageEvent(
        runId,
        stageId,
        {
          event: "failed",
          reason: opened.reason,
        },
        attemptOpt,
      );
      await store.updateRunStatus(runId, "failed");
      return { ok: false, reason: opened.reason };
    }

    opened.handle.deliverAnswer(opaqueAnswer);

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
      err instanceof Error
        ? err.message
        : `resume failed: ${String(err)}`;
    try {
      const latestExecution = await store.getLatestStageExecution(
        runId,
        stageId,
      );
      const attemptCtx = attemptContext(latestExecution?.attempt ?? 1);
      const attemptOpt = attemptCtx.eventOptions();
      await store.appendStageEvent(
        runId,
        stageId,
        {
          event: "failed",
          reason,
        },
        attemptOpt,
      );
      await store.updateRunStatus(runId, "failed");
    } catch {
      // ignore secondary failures
    }
    return { ok: false, reason };
  }
}
