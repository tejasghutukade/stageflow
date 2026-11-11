import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { coerceTaskFile } from "../config/loadTask.js";
import type { RunDetail, RunStore, StageSnapshot } from "../runstore/port.js";
import type { AskOperatorAnswer } from "../tools/askOperator.js";
import {
  isInsideProjectRoot,
  relativizeLocalPathForNetwork,
} from "../config/catalogRelativePath.js";
import type { ResolvedCliProjectRoot } from "./resolveCliProjectRoot.js";
import { resolveCliProjectRootLocal } from "./resolveCliProjectRoot.js";
import {
  PipelinePreflightError,
  PipelineValidationError,
  type PipelineRunResult,
} from "../runtime/pipelineRunner.js";
import type { StartRunResult } from "../runtime/runManager.js";
import type { TaskFile } from "../types/task.js";
import {
  ensureGlobalService,
  hostBaseUrl,
  type EnsureGlobalServiceResult,
} from "../server/ensureGlobalService.js";
import { ackHitlAnswer, collectHitlAnswer, readTTYLine } from "./hitlPrompt.js";
import {
  httpDeliverAnswer,
  httpEnsureProject,
  httpReadRun,
  httpStartRun,
  httpStoreReader,
  runDetailToPipelineRunResult,
} from "./hostClient.js";
import { cliProgressColor, createRunProgressWriter } from "./runProgress.js";
import {
  reportCliRun,
  writeQueuedAdmissionLine,
  type CliRunReportIo,
} from "./runOutput.js";
import { resolveCiIdentity } from "./ciIdentity.js";
import {
  exitCodeForValidation,
  formatValidationHuman,
  formatValidationJson,
} from "./validateOutput.js";

export const RUN_USAGE = `Usage:
  sf run --task <path> --pipeline <path> [--project-root <id-or-path>] [--checkout <path>] [--repository <owner/repo>] [--ref <ref>] [--json] [--include stages] [--skip-gates] [--git-sha <sha>] [--ci-pr-url <url>] [--ci-job-url <url>] [--operator-cwd <path>] [--operator-agent-dir <path>]`;

export type RunCommandIo = CliRunReportIo;

const defaultIo: RunCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedRunArgs = {
  help: boolean;
  json: boolean;
  includeStages: boolean;
  skipGates: boolean;
  task?: string;
  pipeline?: string;
  checkout?: string;
  repository?: string;
  ref?: string;
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
  operatorCwd?: string;
  operatorAgentDir?: string;
  projectRoot?: string;
};

export type StartRunFn = (input: {
  task: string | TaskFile;
  pipeline: string;
  checkoutOverride?: string;
  skipGates?: boolean;
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
}) => Promise<StartRunResult>;

function parseRunArgs(args: string[]): ParsedRunArgs {
  if (args.length === 0) {
    return { help: false, json: false, includeStages: false, skipGates: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false, includeStages: false, skipGates: false };
  }

  let task: string | undefined;
  let pipeline: string | undefined;
  let checkout: string | undefined;
  let repository: string | undefined;
  let ref: string | undefined;
  let gitSha: string | undefined;
  let ciPrUrl: string | undefined;
  let ciJobUrl: string | undefined;
  let operatorCwd: string | undefined;
  let operatorAgentDir: string | undefined;
  let projectRoot: string | undefined;
  let json = false;
  let includeStages = false;
  let skipGates = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--task") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --task");
      }
      task = value;
    } else if (arg === "--pipeline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --pipeline");
      }
      pipeline = value;
    } else if (arg === "--checkout") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --checkout");
      }
      checkout = value;
    } else if (arg === "--repository") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --repository");
      }
      repository = value;
    } else if (arg === "--ref") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --ref");
      }
      ref = value;
    } else if (arg === "--git-sha") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --git-sha");
      }
      gitSha = value;
    } else if (arg === "--ci-pr-url") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --ci-pr-url");
      }
      ciPrUrl = value;
    } else if (arg === "--ci-job-url") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --ci-job-url");
      }
      ciJobUrl = value;
    } else if (arg === "--operator-cwd") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --operator-cwd");
      }
      operatorCwd = value;
    } else if (arg === "--operator-agent-dir") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --operator-agent-dir");
      }
      operatorAgentDir = value;
    } else if (arg === "--project-root") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --project-root");
      }
      projectRoot = value;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--include") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --include");
      }
      if (value === "stages") {
        includeStages = true;
      } else {
        throw new Error(`Unknown --include value: ${value}`);
      }
    } else if (arg === "--skip-gates") {
      skipGates = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help,
    json,
    includeStages,
    skipGates,
    task,
    pipeline,
    checkout,
    repository,
    ref,
    gitSha,
    ciPrUrl,
    ciJobUrl,
    operatorCwd,
    operatorAgentDir,
    projectRoot,
  };
}

function resolvePathUnderCliRoot(
  rootPath: string,
  inputPath: string,
  label: string,
): string {
  const abs = path.resolve(rootPath, inputPath);
  if (!isInsideProjectRoot(rootPath, abs)) {
    throw new Error(`${label} ${abs} is outside project root ${rootPath}`);
  }
  return path.relative(rootPath, abs).replace(/\\/g, "/") || ".";
}

async function loadTaskWithBindingOverrides(
  taskPath: string,
  cwd: string,
  overrides: { repository?: string; ref?: string },
): Promise<TaskFile> {
  const absolute = path.resolve(cwd, taskPath);
  const yamlText = await readFile(absolute, "utf8");
  const raw = parseYaml(yamlText);
  const task = coerceTaskFile(raw);
  if (task === undefined) {
    throw new Error(`Invalid task file ${absolute}: id and goal are required strings`);
  }
  if (overrides.repository !== undefined) task.repository = overrides.repository;
  if (overrides.ref !== undefined) task.ref = overrides.ref;
  return task;
}

function defaultStartRun(
  cwd: string,
  base: string,
  ensureService: () => Promise<EnsureGlobalServiceResult>,
  cliProjectRoot?: ResolvedCliProjectRoot,
  onUpdate?: (detail: RunDetail) => void,
): StartRunFn {
  return async (input) => {
    const ensured = await ensureService();
    if (!ensured.ok) {
      return {
        ok: false,
        reason: ensured.message,
        status: 503,
        ...(ensured.reason === "autostart_disabled"
          ? { code: "autostart_disabled" as const }
          : {}),
      };
    }
    let pipelineRef: { path: string; project_root: string };
    let task: string | TaskFile = input.task;
    let projectRoot: string;
    if (cliProjectRoot) {
      pipelineRef = {
        path: resolvePathUnderCliRoot(cliProjectRoot.rootPath, input.pipeline, "Pipeline"),
        project_root: cliProjectRoot.wireId,
      };
      projectRoot = cliProjectRoot.wireId;
      if (typeof input.task === "string") {
        task = resolvePathUnderCliRoot(cliProjectRoot.rootPath, input.task, "Task");
      }
    } else {
      pipelineRef = relativizeLocalPathForNetwork(cwd, input.pipeline);
      projectRoot = pipelineRef.project_root;
      if (typeof input.task === "string") {
        const absTask = path.resolve(cwd, input.task);
        const cwdAbs = path.resolve(cwd);
        const relTask = path.relative(cwdAbs, absTask);
        if (relTask.startsWith("..") || path.isAbsolute(relTask)) {
          task = await loadTaskWithBindingOverrides(input.task, cwd, {});
        } else {
          const taskRef = relativizeLocalPathForNetwork(cwd, input.task);
          task = taskRef.path;
          projectRoot = taskRef.project_root;
        }
      }
    }
    const ensuredProject = await httpEnsureProject(base, projectRoot);
    if (!ensuredProject.ok) return ensuredProject;
    const checkoutOverride =
      input.checkoutOverride !== undefined
        ? relativizeLocalPathForNetwork(cwd, input.checkoutOverride).path
        : undefined;
    return httpStartRun(
      base,
      {
        pipeline: pipelineRef.path,
        task,
        project_root: ensuredProject.project_root,
        ...(checkoutOverride !== undefined ? { checkoutOverride } : {}),
        ...(input.skipGates !== undefined ? { skipGates: input.skipGates } : {}),
        ...(input.gitSha !== undefined ? { gitSha: input.gitSha } : {}),
        ...(input.ciPrUrl !== undefined ? { ciPrUrl: input.ciPrUrl } : {}),
        ...(input.ciJobUrl !== undefined ? { ciJobUrl: input.ciJobUrl } : {}),
      },
      onUpdate ? { onUpdate } : undefined,
    );
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hitlPromptEnabled(
  json: boolean | undefined,
  options: { stdinIsTTY?: boolean; readLine?: () => Promise<string | null> },
): boolean {
  if (json) return false;
  if (options.readLine !== undefined) return options.stdinIsTTY !== false;
  return (options.stdinIsTTY ?? process.stdin.isTTY) === true;
}

function resumeActivity(answer: AskOperatorAnswer): string {
  if (answer.kind === "confirm" || answer.kind === "artifact_backed") {
    return answer.decision === "accept" ? "accepted" : "rejected";
  }
  return "answered";
}

function sameOpenGate(
  detail: RunDetail,
  answered: { stageId: string; promptId: string },
): boolean {
  if (detail.waiting_stage_id !== answered.stageId) return false;
  const stage = detail.stages.find((item) => item.stage_id === answered.stageId);
  return stage?.pending_prompt?.id === answered.promptId;
}

function withResumeActivity(
  detail: RunDetail,
  stageId: string,
  activity: string,
): RunDetail {
  return {
    ...detail,
    stages: detail.stages.map((stage) => {
      if (stage.stage_id !== stageId) return stage;
      const resumed: StageSnapshot = {
        ...stage,
        status: "running",
        pending_prompt: undefined,
        events: [
          ...stage.events,
          { event: "message", role: "assistant", text: activity },
        ],
      };
      return resumed;
    }),
  };
}

async function pollAfterAnswer(
  readRun: (runId: string) => Promise<RunDetail>,
  runId: string,
  answered: { stageId: string; promptId: string },
  onUpdate: ((detail: RunDetail) => void) | undefined,
  pollIntervalMs: number,
  shouldStop: () => boolean,
): Promise<{ stopped: true } | { stopped: false; detail: RunDetail }> {
  for (;;) {
    if (shouldStop()) return { stopped: true };
    const detail = await readRun(runId);
    const stillOpen = sameOpenGate(detail, answered);
    if (!stillOpen) {
      try {
        onUpdate?.(detail);
      } catch {
        // A progress-line failure must not fail the run.
      }
    }
    if (
      detail.status === "succeeded" ||
      detail.status === "failed" ||
      detail.status === "cancelled"
    ) {
      return { stopped: false, detail };
    }
    if (!stillOpen && detail.waiting_stage_id !== undefined) {
      return { stopped: false, detail };
    }
    await sleep(pollIntervalMs);
  }
}

export async function continueThroughGates(
  result: PipelineRunResult,
  deps: {
    io: RunCommandIo;
    readLine: () => Promise<string | null>;
    readRun: (runId: string) => Promise<RunDetail>;
    deliverAnswer: (
      runId: string,
      stageId: string,
      answer: unknown,
    ) => Promise<{ ok: true } | { ok: false; reason: string }>;
    onUpdate?: (detail: RunDetail) => void;
    resetProgress?: () => void;
    pollIntervalMs?: number;
  },
): Promise<{ result: PipelineRunResult; failed: boolean }> {
  let current = result;
  while (current.outcome === "waiting" && current.waitingStageId) {
    let detail: RunDetail;
    try {
      detail = await deps.readRun(current.runId);
    } catch (err) {
      deps.io.error(err instanceof Error ? err.message : String(err));
      return { result: current, failed: true };
    }
    const stage = detail.stages.find((item) => item.stage_id === current.waitingStageId);
    const prompt = stage?.pending_prompt;
    if (!prompt) return { result: current, failed: false };
    deps.io.log("");
    const answer = await collectHitlAnswer(
      prompt,
      { log: deps.io.log, readLine: deps.readLine },
      { runDir: current.runDir, stageArtifacts: stage?.artifacts ?? [] },
    );
    if (!answer) {
      deps.io.log("Cancelled.");
      return { result: current, failed: false };
    }
    deps.io.log(ackHitlAnswer(answer));
    deps.resetProgress?.();
    try {
      deps.onUpdate?.(withResumeActivity(detail, current.waitingStageId, resumeActivity(answer)));
    } catch {
      // A progress-line failure must not fail the run.
    }
    let answerFailure: string | undefined;
    const delivery = deps
      .deliverAnswer(current.runId, current.waitingStageId, answer)
      .then((delivered) => {
        if (!delivered.ok) answerFailure = delivered.reason;
        return delivered;
      });
    try {
      const polled = await pollAfterAnswer(
        deps.readRun,
        current.runId,
        { stageId: current.waitingStageId, promptId: prompt.id },
        deps.onUpdate,
        deps.pollIntervalMs ?? 500,
        () => answerFailure !== undefined,
      );
      const delivered = await delivery;
      if (!delivered.ok) {
        deps.io.error(delivered.reason);
        return { result: current, failed: true };
      }
      if (polled.stopped) {
        deps.io.error(answerFailure ?? "The run did not resume.");
        return { result: current, failed: true };
      }
      current = runDetailToPipelineRunResult(polled.detail);
    } catch (err) {
      deps.io.error(err instanceof Error ? err.message : String(err));
      return { result: current, failed: true };
    }
  }
  return { result: current, failed: false };
}

export async function completeCliRun(
  started: Extract<StartRunResult, { ok: true }>,
  io: RunCommandIo = defaultIo,
  options: {
    json?: boolean;
    store?: Pick<RunStore, "readRun">;
    includeStages?: boolean;
  } = {},
): Promise<number> {
  if (!options.json) {
    io.log(`Run ${started.runId}`);
  }
  const result = await started.done;
  return reportCliRun(
    { kind: "completion", result },
    {
      json: options.json,
      io,
      store: options.store,
      includeStages: options.includeStages,
    },
  );
}

export async function runRunCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<RunCommandIo>;
    startRun?: StartRunFn;
    store?: Pick<RunStore, "readRun">;
    env?: Record<string, string | undefined>;
    stdinIsTTY?: boolean;
    readLine?: () => Promise<string | null>;
    hostBaseUrl?: string;
    ensureService?: () => Promise<EnsureGlobalServiceResult>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: RunCommandIo = { ...defaultIo, ...options.io };
  const base = options.hostBaseUrl ?? hostBaseUrl();

  let parsed: ParsedRunArgs;
  try {
    parsed = parseRunArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(RUN_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(RUN_USAGE);
    return 0;
  }

  if (!parsed.task || !parsed.pipeline) {
    out.error("Missing --task and/or --pipeline");
    out.error(RUN_USAGE);
    return 1;
  }

  if (parsed.includeStages && !parsed.json) {
    out.error("error: --include stages requires --json");
    return 1;
  }

  if (parsed.operatorCwd !== undefined || parsed.operatorAgentDir !== undefined) {
    out.error(
      "warning: --operator-cwd/--operator-agent-dir have no effect on `sf run` now that pipelines execute in the shared global Stageflow service; set STAGEFLOW_OPERATOR_CWD/STAGEFLOW_OPERATOR_AGENT_DIR before that service first starts instead.",
    );
  }

  let cliProjectRoot: ResolvedCliProjectRoot | undefined;
  if (parsed.projectRoot !== undefined) {
    const local = resolveCliProjectRootLocal(parsed.projectRoot);
    if (!local) {
      out.error(`Unknown project_root: ${parsed.projectRoot.trim()}`);
      out.error(RUN_USAGE);
      return 1;
    }
    cliProjectRoot = local;
  }

  const progress = parsed.json
    ? undefined
    : createRunProgressWriter({
        write: (chunk) => {
          process.stdout.write(chunk);
        },
        tty: process.stdout.isTTY === true,
        color: cliProgressColor(
          process.stdout.isTTY === true,
          options.env ?? process.env,
        ),
      });

  const startRun =
    options.startRun ??
    defaultStartRun(
      cwd,
      base,
      options.ensureService ?? (() => ensureGlobalService()),
      cliProjectRoot,
      progress ? (detail) => progress.update(detail) : undefined,
    );
  const identity = resolveCiIdentity({
    flags: {
      gitSha: parsed.gitSha,
      ciPrUrl: parsed.ciPrUrl,
      ciJobUrl: parsed.ciJobUrl,
    },
    env: options.env ?? process.env,
  });

  const store =
    options.store ?? (parsed.includeStages ? httpStoreReader(base) : undefined);

  try {
    const hasBindingOverride =
      parsed.repository !== undefined || parsed.ref !== undefined;
    const taskLoadRoot = cliProjectRoot?.rootPath ?? cwd;
    const taskInput: string | TaskFile = hasBindingOverride
      ? await loadTaskWithBindingOverrides(parsed.task, taskLoadRoot, {
          repository: parsed.repository,
          ref: parsed.ref,
        })
      : parsed.task;

    const started = await startRun({
      task: taskInput,
      pipeline: parsed.pipeline,
      checkoutOverride: parsed.checkout,
      ...(parsed.skipGates ? { skipGates: true } : {}),
      ...identity,
    });
    if (!started.ok) {
      return reportCliRun(
        { kind: "start-failure", started },
        { json: parsed.json, io: out },
      );
    }
    writeQueuedAdmissionLine(started, out);
    if (!hitlPromptEnabled(parsed.json, options)) {
      return completeCliRun(started, out, {
        json: parsed.json,
        includeStages: parsed.includeStages,
        store,
      });
    }
    out.log(`Run ${started.runId}`);
    const driven = await continueThroughGates(await started.done, {
      io: out,
      readLine: options.readLine ?? readTTYLine,
      readRun: (runId) => httpReadRun(base, runId),
      deliverAnswer: (runId, stageId, answer) =>
        httpDeliverAnswer(base, runId, stageId, answer),
      ...(progress
        ? {
            onUpdate: (detail: RunDetail) => progress.update(detail),
            resetProgress: () => progress.reset(),
          }
        : {}),
    });
    if (driven.failed) return 1;
    return reportCliRun(
      { kind: "completion", result: driven.result },
      {
        json: false,
        io: out,
        store,
        includeStages: parsed.includeStages,
      },
    );
  } catch (err) {
    if (err instanceof PipelineValidationError) {
      if (parsed.json) {
        out.log(formatValidationJson(err.result));
      } else {
        out.error(formatValidationHuman(err.result));
      }
      return exitCodeForValidation(err.result);
    }
    if (err instanceof PipelinePreflightError) {
      if (parsed.json) {
        out.log(JSON.stringify(err.toNetworkBody(), null, 2));
      } else {
        out.error(err.message);
      }
      return 1;
    }
    out.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
