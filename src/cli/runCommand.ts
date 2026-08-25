import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiAgentAdapter } from "../agent/piAdapter.js";
import { createRunStore } from "../runstore/createStore.js";
import {
  PipelineValidationError,
  type PipelineRunResult,
} from "../runtime/pipelineRunner.js";
import { RunManager, type StartRunResult } from "../runtime/runManager.js";
import { readStageExecutionMode } from "../runtime/stageConcurrency.js";
import { STAGE_WORKER_EXIT } from "../runtime/stageWorkerProtocol.js";
import {
  exitCodeForRunOutcome,
  formatRunCompletionJson,
  formatStartFailureJson,
} from "./runOutput.js";
import {
  exitCodeForValidation,
  formatValidationHuman,
  formatValidationJson,
} from "./validateOutput.js";

export const RUN_USAGE = `Usage:
  sf run --task <path> --pipeline <name-or-path> [--checkout <path>] [--json] [--skip-gates]`;

export type RunCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: RunCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedRunArgs = {
  help: boolean;
  json: boolean;
  skipGates: boolean;
  task?: string;
  pipeline?: string;
  checkout?: string;
};

export type StartRunFn = (input: {
  task: string;
  pipeline: string;
  checkoutOverride?: string;
  skipGates?: boolean;
}) => Promise<StartRunResult>;

function parseRunArgs(args: string[]): ParsedRunArgs {
  if (args.length === 0) {
    return { help: false, json: false, skipGates: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false, skipGates: false };
  }

  let task: string | undefined;
  let pipeline: string | undefined;
  let checkout: string | undefined;
  let json = false;
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
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--skip-gates") {
      skipGates = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, json, skipGates, task, pipeline, checkout };
}

function defaultStartRun(cwd: string): StartRunFn {
  return async (input) => {
    const store = createRunStore({ rootDir: cwd });
    const manager = new RunManager({
      agent: new PiAgentAdapter(),
      store,
      cwd,
      operatorCatalog: { cwd, agentDir: getAgentDir() },
      executionMode: readStageExecutionMode(process.env, "process"),
    });
    return manager.startRun(input);
  };
}

export function exitForPipelineRunResult(
  result: PipelineRunResult,
  io: RunCommandIo = defaultIo,
): number {
  switch (result.outcome) {
    case "waiting":
      io.error(
        `Pipeline waiting. Run folder: ${result.runDir} (${result.runId})`,
      );
      return STAGE_WORKER_EXIT.WAITING;
    case "failed":
      io.error(`Pipeline failed: ${result.reason}`);
      io.error(`Run folder: ${result.runDir}`);
      return STAGE_WORKER_EXIT.FAILED;
    case "succeeded":
      io.log(`Pipeline succeeded. Run folder: ${result.runDir}`);
      return STAGE_WORKER_EXIT.SUCCEEDED;
  }
}

export async function completeCliRun(
  started: Extract<StartRunResult, { ok: true }>,
  io: RunCommandIo = defaultIo,
  options: { json?: boolean } = {},
): Promise<number> {
  const result = await started.done;
  if (options.json) {
    io.log(formatRunCompletionJson(result));
    return exitCodeForRunOutcome(result.outcome);
  }
  return exitForPipelineRunResult(result, io);
}

export async function runRunCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<RunCommandIo>;
    startRun?: StartRunFn;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
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

  const startRun = options.startRun ?? defaultStartRun(cwd);

  try {
    const started = await startRun({
      task: parsed.task,
      pipeline: parsed.pipeline,
      checkoutOverride: parsed.checkout,
      ...(parsed.skipGates ? { skipGates: true } : {}),
    });
    if (!started.ok) {
      if (parsed.json) {
        out.log(formatStartFailureJson(started));
        return 1;
      }
      const code = started.code ?? "error";
      out.error(`${code}: ${started.reason}`);
      if (started.conflictingRunId !== undefined) {
        out.error(`conflictingRunId: ${started.conflictingRunId}`);
      }
      if (started.conflictingCheckout !== undefined) {
        out.error(`conflictingCheckout: ${started.conflictingCheckout}`);
      }
      return 1;
    }
    return completeCliRun(started, out, { json: parsed.json });
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
