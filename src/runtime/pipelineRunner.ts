import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunSubmission } from "../runstore/submission.js";
import type { AgentPort } from "../agent/port.js";
import {
  buildValidationResult,
  loadPipelineValidated,
  type ValidationFinding,
} from "../config/validateCatalog.js";
import { loadTaskFromYaml } from "../config/loadTask.js";
import type { RunStore } from "../runstore/port.js";
import {
  resolveAndValidateCheckout,
  resolveEffectiveGitIdentity,
} from "./stageRoots.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { StageHitlController } from "./stageHitl.js";
import type { InlinePipelineDefinition, LoadedPipeline } from "../types/pipeline.js";
import type { TaskFile } from "../types/task.js";
import { buildPipelineDagSnapshotFromLoaded } from "../runstore/pipelineDagSnapshot.js";
import { normalizeCatalogPath } from "../runstore/normalizeCatalogPath.js";
import { runPipelineDag } from "./pipelineScheduler.js";
import {
  readMaxActiveStagesPerRun,
  readStageExecutionMode,
  type StageExecutionMode,
} from "./stageConcurrency.js";
import { StageProcessLauncher } from "./stageProcessLauncher.js";
import { PipelineValidationError } from "./pipelineValidationError.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";
import { checkTaskEntryInput } from "./taskInput.js";
import { pipelinePersistenceForStart } from "./startPayload.js";

export { PipelineValidationError } from "./pipelineValidationError.js";

export type PipelineRunOutcome = "succeeded" | "failed" | "waiting" | "cancelled";

export class InlinePipelineTooLargeError extends Error {
  readonly code = "inline_pipeline_too_large" as const;
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(
      `Inline pipeline body is ${bytes} bytes; max is ${maxBytes} (inline_pipeline_too_large)`,
    );
    this.name = "InlinePipelineTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

/** Thrown when queued→running CAS fails (e.g. cancel won the race). */
export class QueuedRunActivationAborted extends Error {
  readonly runId: string;
  readonly currentStatus?: string;

  constructor(runId: string, currentStatus?: string) {
    super(
      currentStatus === undefined
        ? `Queued run ${runId} could not be activated`
        : `Queued run ${runId} could not be activated (status=${currentStatus})`,
    );
    this.name = "QueuedRunActivationAborted";
    this.runId = runId;
    this.currentStatus = currentStatus;
  }
}

export type PipelineRunResult = {
  ok: boolean;
  outcome: PipelineRunOutcome;
  runDir: string;
  runId: string;
  reason?: string;
  findings?: ValidationFinding[];
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
  findings?: ValidationFinding[];
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
  submission?: RunSubmission;
  agent: AgentPort;
  store: RunStore;
  taskPath?: string;
  taskYaml?: string;
  pipeline: string | InlinePipelineDefinition;
  cwd: string;
  projectRoot?: string;
  checkoutOverride?: string;
  /** Preallocated run id + binding fields from Host materialize (KTD1). */
  runId?: string;
  /**
   * When true with `runId`, activate an existing `queued` row instead of createRun
   * (admission-queue dequeue path — KTD2).
   */
  reuseExistingRun?: boolean;
  checkoutRoot?: string;
  repository?: string;
  ref?: string;
  resolvedSha?: string;
  runBranch?: string;
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
    projectRoot: options.projectRoot ?? options.cwd,
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
  const pairing = checkTaskEntryInput(task, loaded, {
    cwd: options.cwd,
    taskPath: options.taskPath,
  });
  if (pairing.some((finding) => finding.severity === "error")) {
    throw new PipelineValidationError(
      buildValidationResult("pipeline", pairing, false),
    );
  }
  const warningFindings = [
    ...loadResult.findings.filter((finding) => finding.severity === "warning"),
    ...pairing.filter((finding) => finding.severity === "warning"),
  ];
  for (const finding of warningFindings) {
    console.error(`${finding.code}: ${finding.message}`);
  }

  // Materialization is owned by RunManager (KTD1). When checkoutRoot is supplied,
  // do not re-resolve or fetch here.
  const checkoutRoot =
    options.checkoutRoot !== undefined
      ? options.checkoutRoot
      : await resolveAndValidateCheckout(
          task,
          options.checkoutOverride,
          options.cwd,
        );

  const pipelinePath =
    typeof options.pipeline === "string"
      ? normalizeCatalogPath(loaded.pipelinePath)
      : undefined;
  const persistence = pipelinePersistenceForStart(options.pipeline);
  if (!persistence.ok) {
    throw new InlinePipelineTooLargeError(
      persistence.bytes,
      persistence.maxBytes,
    );
  }
  const taskPath = options.taskPath
    ? normalizeCatalogPath(path.resolve(options.cwd, options.taskPath))
    : undefined;
  const projectRoot = normalizeCatalogPath(
    options.projectRoot ?? options.cwd,
  );

  const gitIdentity = resolveEffectiveGitIdentity(
    process.env,
    task.git_identity,
  );

  let run: { runId: string; workspaceDir: string };
  if (options.reuseExistingRun === true) {
    const runId = options.runId;
    if (runId === undefined || runId.trim() === "") {
      throw new Error("reuseExistingRun requires a preallocated runId");
    }
    await options.store.patchRunWorkspaceBinding(runId, {
      ...(checkoutRoot !== undefined ? { checkoutRoot } : {}),
      ...(options.repository !== undefined
        ? { repository: options.repository }
        : {}),
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
      ...(options.resolvedSha !== undefined
        ? { resolvedSha: options.resolvedSha }
        : {}),
      ...(options.runBranch !== undefined
        ? { runBranch: options.runBranch }
        : {}),
    });
    const activated = await options.store.tryUpdateRunStatus(
      runId,
      "running",
      "queued",
    );
    if (!activated) {
      let currentStatus: string | undefined;
      try {
        currentStatus = (await options.store.readRunMeta(runId)).status;
      } catch {
        currentStatus = undefined;
      }
      throw new QueuedRunActivationAborted(runId, currentStatus);
    }
    run = { runId, workspaceDir: options.store.getWorkspaceDir(runId) };
  } else {
    run = await options.store.createRun({
      submission: options.submission,
      runId: options.runId,
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      checkoutRoot,
      gitSha: options.gitSha,
      ciPrUrl: options.ciPrUrl,
      ciJobUrl: options.ciJobUrl,
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
      pipelinePath,
      taskPath,
      projectRoot,
      repository: options.repository,
      ref: options.ref,
      resolvedSha: options.resolvedSha,
      runBranch: options.runBranch,
      gitAuthorName: gitIdentity.name,
      gitAuthorEmail: gitIdentity.email,
      pipelineSource: persistence.fields.pipelineSource,
      ...(persistence.fields.pipelineBody !== undefined
        ? { pipelineBody: persistence.fields.pipelineBody }
        : {}),
      skipGates: options.skipGates,
    });
  }
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
    ...(warningFindings.length > 0 ? { findings: warningFindings } : {}),
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
  schedulingHalt?: { halted: boolean };
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
  const result = await runPipelineDag({
    prepared,
    maxActiveStagesPerRun,
    resumeFromStageId: options?.resumeFromStageId,
    initialPrior: options?.initialPrior,
    startAtStageIndex: options?.startAtStageIndex,
    executionMode,
    stageProcessLauncher,
    schedulingHalt: options?.schedulingHalt,
  });
  if (prepared.findings !== undefined && prepared.findings.length > 0) {
    return { ...result, findings: prepared.findings };
  }
  return result;
}

export async function runPipeline(options: {
  agent: AgentPort;
  store: RunStore;
  taskPath?: string;
  taskYaml?: string;
  pipeline: string | InlinePipelineDefinition;
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
  submission?: RunSubmission;
  agent: AgentPort;
  store: RunStore;
  taskPath?: string;
  taskYaml?: string;
  pipeline: string | InlinePipelineDefinition;
  cwd?: string;
  projectRoot?: string;
  checkoutOverride?: string;
  runId?: string;
  checkoutRoot?: string;
  repository?: string;
  ref?: string;
  resolvedSha?: string;
  runBranch?: string;
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
  reuseExistingRun?: boolean;
  hitl?: StageHitlController;
  maxActiveStagesPerRun?: number;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
  schedulingHalt?: { halted: boolean };
}): Promise<StartedPipeline> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const prepared = await preparePipeline({
    submission: options.submission,
    agent: options.agent,
    store: options.store,
    taskPath: options.taskPath,
    taskYaml: options.taskYaml,
    pipeline: options.pipeline,
    cwd,
    projectRoot,
    checkoutOverride: options.checkoutOverride,
    runId: options.runId,
    reuseExistingRun: options.reuseExistingRun,
    checkoutRoot: options.checkoutRoot,
    repository: options.repository,
    ref: options.ref,
    resolvedSha: options.resolvedSha,
    runBranch: options.runBranch,
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
    schedulingHalt: options.schedulingHalt,
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
