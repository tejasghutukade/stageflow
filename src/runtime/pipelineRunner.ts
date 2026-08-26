import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentPort } from "../agent/port.js";
import { loadPipelineValidated } from "../config/loadPipeline.js";
import { loadTaskFromYaml } from "../config/loadTask.js";
import { buildValidationResult } from "../config/validateCatalog.js";
import type { RunStore } from "../runstore/port.js";
import { resolveAndValidateCheckout } from "./stageRoots.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { StageHitlController } from "./stageHitl.js";
import type { LoadedPipeline } from "../types/pipeline.js";
import type { TaskFile } from "../types/task.js";
import { buildPipelineDagSnapshotFromLoaded } from "../runstore/pipelineDagSnapshot.js";
import { runPipelineDag } from "./pipelineScheduler.js";
import {
  readMaxActiveStagesPerRun,
  readStageExecutionMode,
  type StageExecutionMode,
} from "./stageConcurrency.js";
import { StageProcessLauncher } from "./stageProcessLauncher.js";
import { PipelineValidationError } from "./pipelineValidationError.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";

export { PipelineValidationError } from "./pipelineValidationError.js";

export type PipelineRunOutcome = "succeeded" | "failed" | "waiting";

export type PipelineRunResult = {
  ok: boolean;
  outcome: PipelineRunOutcome;
  runDir: string;
  runId: string;
  reason?: string;
};

export type StartedPipeline = {
  runId: string;
  runDir: string;
  done: Promise<PipelineRunResult>;
};

export type PreparedPipeline = {
  task: TaskFile;
  loaded: LoadedPipeline;
  run: { runId: string; workspaceDir: string };
  agent: AgentPort;
  store: RunStore;
  cwd: string;
  projectRoot: string;
  checkoutRoot?: string;
  hitl?: StageHitlController;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
};

let defaultStageProcessLauncher: StageProcessLauncher | undefined;

function resolveStageProcessLauncher(
  executionMode: StageExecutionMode,
  override?: StageProcessLauncher,
): StageProcessLauncher | undefined {
  if (executionMode !== "process") {
    return undefined;
  }
  if (override !== undefined) {
    return override;
  }
  if (defaultStageProcessLauncher === undefined) {
    defaultStageProcessLauncher = new StageProcessLauncher();
  }
  return defaultStageProcessLauncher;
}

async function preparePipeline(options: {
  agent: AgentPort;
  store: RunStore;
  taskPath?: string;
  taskYaml?: string;
  pipeline: string;
  cwd: string;
  projectRoot?: string;
  checkoutOverride?: string;
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
  hitl?: StageHitlController;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
}): Promise<PreparedPipeline> {
  const loadResult = await loadPipelineValidated(options.pipeline, {
    cwd: options.cwd,
    validateStages: true,
  });
  if (!loadResult.ok) {
    throw new PipelineValidationError(
      buildValidationResult("pipeline", loadResult.findings, false),
    );
  }
  const loaded = loadResult.loaded;

  const taskYaml =
    options.taskYaml ??
    (options.taskPath
      ? await readFile(options.taskPath, "utf8")
      : (() => {
          throw new Error("taskPath or taskYaml is required");
        })());
  const label = options.taskPath ?? "task.yaml";
  const task = loadTaskFromYaml(taskYaml, `task file ${label}`);

  const checkoutRoot = await resolveAndValidateCheckout(
    task,
    options.checkoutOverride,
    options.cwd,
  );

  const run = await options.store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    checkoutRoot,
    gitSha: options.gitSha,
    ciPrUrl: options.ciPrUrl,
    ciJobUrl: options.ciJobUrl,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
  const executionMode = readStageExecutionMode(
    process.env,
    options.executionMode,
  );
  const stageProcessLauncher = resolveStageProcessLauncher(
    executionMode,
    options.stageProcessLauncher,
  );
  return {
    task,
    loaded,
    run,
    agent: options.agent,
    store: options.store,
    cwd: options.cwd,
    projectRoot: options.projectRoot ?? options.cwd,
    checkoutRoot,
    hitl: options.hitl,
    executionMode,
    stageProcessLauncher,
    operatorCatalog: options.operatorCatalog,
    skipGates: options.skipGates,
  };
}

export type ExecuteStagesOptions = {
  maxActiveStagesPerRun?: number;
  resumeFromStageId?: string;
  initialPrior?: StageEnvelope | null;
  /** @deprecated Linear pipelines only — use resumeFromStageId for DAG resume. */
  startAtStageIndex?: number;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
};

export async function executeStages(
  prepared: PreparedPipeline,
  options?: ExecuteStagesOptions,
): Promise<PipelineRunResult> {
  const maxActiveStagesPerRun = readMaxActiveStagesPerRun(
    process.env,
    options?.maxActiveStagesPerRun,
  );
  const executionMode =
    options?.executionMode ??
    prepared.executionMode ??
    readStageExecutionMode(process.env);
  const stageProcessLauncher = resolveStageProcessLauncher(
    executionMode,
    options?.stageProcessLauncher ?? prepared.stageProcessLauncher,
  );
  return runPipelineDag({
    prepared,
    maxActiveStagesPerRun,
    resumeFromStageId: options?.resumeFromStageId,
    initialPrior: options?.initialPrior,
    startAtStageIndex: options?.startAtStageIndex,
    executionMode,
    stageProcessLauncher,
  });
}

export async function runPipeline(options: {
  agent: AgentPort;
  store: RunStore;
  taskPath?: string;
  taskYaml?: string;
  pipeline: string;
  cwd?: string;
  projectRoot?: string;
  checkoutOverride?: string;
  hitl?: StageHitlController;
  maxActiveStagesPerRun?: number;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
}): Promise<PipelineRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const prepared = await preparePipeline({
    agent: options.agent,
    store: options.store,
    taskPath: options.taskPath,
    taskYaml: options.taskYaml,
    pipeline: options.pipeline,
    cwd,
    projectRoot,
    checkoutOverride: options.checkoutOverride,
    hitl: options.hitl,
    executionMode: options.executionMode,
    stageProcessLauncher: options.stageProcessLauncher,
    operatorCatalog: options.operatorCatalog,
    skipGates: options.skipGates,
  });
  return executeStages(prepared, {
    maxActiveStagesPerRun: options.maxActiveStagesPerRun,
    executionMode: prepared.executionMode,
    stageProcessLauncher: prepared.stageProcessLauncher,
  });
}

/** Create the run immediately, then execute stages in the returned promise. */
export async function startPipeline(options: {
  agent: AgentPort;
  store: RunStore;
  taskPath?: string;
  taskYaml?: string;
  pipeline: string;
  cwd?: string;
  projectRoot?: string;
  checkoutOverride?: string;
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
  hitl?: StageHitlController;
  maxActiveStagesPerRun?: number;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
}): Promise<StartedPipeline> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const prepared = await preparePipeline({
    agent: options.agent,
    store: options.store,
    taskPath: options.taskPath,
    taskYaml: options.taskYaml,
    pipeline: options.pipeline,
    cwd,
    projectRoot,
    checkoutOverride: options.checkoutOverride,
    gitSha: options.gitSha,
    ciPrUrl: options.ciPrUrl,
    ciJobUrl: options.ciJobUrl,
    hitl: options.hitl,
    executionMode: options.executionMode,
    stageProcessLauncher: options.stageProcessLauncher,
    operatorCatalog: options.operatorCatalog,
    skipGates: options.skipGates,
  });
  const done = executeStages(prepared, {
    maxActiveStagesPerRun: options.maxActiveStagesPerRun,
    executionMode: prepared.executionMode,
    stageProcessLauncher: prepared.stageProcessLauncher,
  }).catch(async (err) => {
    await prepared.store.updateRunStatus(prepared.run.runId, "failed").catch(() => undefined);
    return {
      ok: false as const,
      outcome: "failed" as const,
      runDir: prepared.run.workspaceDir,
      runId: prepared.run.runId,
      reason: err instanceof Error ? err.message : String(err),
    };
  });
  return {
    runId: prepared.run.runId,
    runDir: prepared.run.workspaceDir,
    done,
  };
}

export function resolveTaskPath(taskArg: string, cwd = process.cwd()): string {
  return path.resolve(cwd, taskArg);
}
