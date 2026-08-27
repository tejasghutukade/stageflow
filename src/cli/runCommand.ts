import { PiAgentAdapter } from "../agent/piAdapter.js";
import { createRunStore } from "../runstore/createStore.js";
import type { RunStore } from "../runstore/port.js";
import { PipelineValidationError } from "../runtime/pipelineRunner.js";
import { RunManager, type StartRunResult } from "../runtime/runManager.js";
import { readStageExecutionMode } from "../runtime/stageConcurrency.js";
import {
  reportCliRun,
  type CliRunReportIo,
} from "./runOutput.js";
import { resolveCiIdentity } from "./ciIdentity.js";
import { resolveOperatorCatalog } from "./operatorCatalog.js";
import type { OperatorCatalog } from "../runtime/stageAttemptBootstrap.js";
import {
  exitCodeForValidation,
  formatValidationHuman,
  formatValidationJson,
} from "./validateOutput.js";

export const RUN_USAGE = `Usage:
  sf run --task <path> --pipeline <path> [--checkout <path>] [--json] [--include stages] [--skip-gates] [--git-sha <sha>] [--ci-pr-url <url>] [--ci-job-url <url>] [--operator-cwd <path>] [--operator-agent-dir <path>]`;

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
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
  operatorCwd?: string;
  operatorAgentDir?: string;
};

export type StartRunFn = (input: {
  task: string;
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
    gitSha,
    ciPrUrl,
    ciJobUrl,
    operatorCwd,
    operatorAgentDir,
  };
}

function defaultStartRun(
  cwd: string,
  projectRoot: string,
  isGitProject: boolean,
  operatorCatalog: OperatorCatalog,
): StartRunFn {
  return async (input) => {
    const store = createRunStore({ rootDir: projectRoot });
    const manager = new RunManager({
      agent: new PiAgentAdapter(),
      store,
      cwd,
      projectRoot,
      isGitProject,
      operatorCatalog,
      executionMode: readStageExecutionMode(process.env, "process"),
    });
    return manager.startRun(input);
  };
}

export async function completeCliRun(
  started: Extract<StartRunResult, { ok: true }>,
  io: RunCommandIo = defaultIo,
  options: {
    json?: boolean;
    store?: RunStore;
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
    projectRoot?: string;
    isGitProject?: boolean;
    io?: Partial<RunCommandIo>;
    startRun?: StartRunFn;
    store?: RunStore;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const isGitProject = options.isGitProject ?? false;
  const out: RunCommandIo = { ...defaultIo, ...options.io };

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

  const operatorCatalog = resolveOperatorCatalog({
    flags: {
      operatorCwd: parsed.operatorCwd,
      operatorAgentDir: parsed.operatorAgentDir,
    },
    env: options.env ?? process.env,
    defaultCwd: cwd,
  });
  const startRun =
    options.startRun ??
    defaultStartRun(cwd, projectRoot, isGitProject, operatorCatalog);
  const identity = resolveCiIdentity({
    flags: {
      gitSha: parsed.gitSha,
      ciPrUrl: parsed.ciPrUrl,
      ciJobUrl: parsed.ciJobUrl,
    },
    env: options.env ?? process.env,
  });

  const store =
    options.store ??
    (parsed.includeStages
      ? createRunStore({ rootDir: projectRoot })
      : undefined);

  try {
    const started = await startRun({
      task: parsed.task,
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
    out.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
