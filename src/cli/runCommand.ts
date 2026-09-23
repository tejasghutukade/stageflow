import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { coerceTaskFile } from "../config/loadTask.js";
import type { RunStore } from "../runstore/port.js";
import { relativizeLocalPathForNetwork } from "../config/catalogRelativePath.js";
import { PipelinePreflightError, PipelineValidationError } from "../runtime/pipelineRunner.js";
import type { StartRunResult } from "../runtime/runManager.js";
import type { TaskFile } from "../types/task.js";
import {
  ensureGlobalService,
  hostBaseUrl,
  type EnsureGlobalServiceResult,
} from "../server/ensureGlobalService.js";
import { httpStartRun, httpStoreReader, resolveAbsolute } from "./hostClient.js";
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
  sf run --task <path> --pipeline <path> [--checkout <path>] [--repository <owner/repo>] [--ref <ref>] [--json] [--include stages] [--skip-gates] [--git-sha <sha>] [--ci-pr-url <url>] [--ci-job-url <url>] [--operator-cwd <path>] [--operator-agent-dir <path>]`;

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
  };
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
    const pipelineRef = relativizeLocalPathForNetwork(cwd, input.pipeline);
    let task: string | TaskFile = input.task;
    let projectRoot = pipelineRef.project_root;
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
    return httpStartRun(base, {
      pipeline: pipelineRef.path,
      task,
      project_root: projectRoot,
      ...(input.checkoutOverride !== undefined
        ? { checkoutOverride: resolveAbsolute(cwd, input.checkoutOverride) }
        : {}),
      ...(input.skipGates !== undefined ? { skipGates: input.skipGates } : {}),
      ...(input.gitSha !== undefined ? { gitSha: input.gitSha } : {}),
      ...(input.ciPrUrl !== undefined ? { ciPrUrl: input.ciPrUrl } : {}),
      ...(input.ciJobUrl !== undefined ? { ciJobUrl: input.ciJobUrl } : {}),
    });
  };
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

  const startRun =
    options.startRun ??
    defaultStartRun(cwd, base, options.ensureService ?? (() => ensureGlobalService()));
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
    const taskInput: string | TaskFile = hasBindingOverride
      ? await loadTaskWithBindingOverrides(parsed.task, cwd, {
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
    return completeCliRun(started, out, {
      json: parsed.json,
      includeStages: parsed.includeStages,
      store,
    });
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
