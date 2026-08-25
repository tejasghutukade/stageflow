#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiAgentAdapter } from "./agent/piAdapter.js";
import { PROVIDERS_USAGE, runProvidersCommand } from "./cli/providersCommand.js";
import { RUN_USAGE, runRunCommand } from "./cli/runCommand.js";
import { VALIDATE_USAGE, runValidateCommand } from "./cli/validateCommand.js";
import { createRunStore } from "./runstore/createStore.js";
import { exitForOutcome, runStageWorker } from "./runtime/stageWorker.js";
import { SF_STAGE_WORKER } from "./runtime/stageWorkerProtocol.js";
import type { OperatorCatalog } from "./runtime/stageAttemptBootstrap.js";
import { DEFAULT_PORT, startUiServer } from "./server/http.js";

const USAGE = `Usage:
  sf run --task <path> --pipeline <name-or-path> [--checkout <path>] [--json] [--skip-gates]
  sf validate [--pipeline <name-or-path>] [--strict] [--json]
  sf ui [--port ${DEFAULT_PORT}]
  sf providers list
  sf providers status [--provider <id>]
  sf providers detect
  sf providers source [get | set <pi_home|sf_owned>]
  sf providers login <providerId> [--type api_key|oauth] [--api-key-env <VAR>]
  sf providers logout <providerId>
  sf --help

Stageflow (sf) runs YAML-defined automatic stage pipelines.

Store backend: SF_STORE=sqlite only. SF_STORE=disk is rejected; disk-era .stageflow/runs trees import when the SQLite store is empty. Data under .stageflow/.

${RUN_USAGE}

${VALIDATE_USAGE}

${PROVIDERS_USAGE}`;

function parseArgs(argv: string[]): {
  help: boolean;
  command?: string;
  task?: string;
  pipeline?: string;
  port?: number;
  checkout?: string;
} {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { help: true };
  }
  if (
    (args[0] === "--help" || args[0] === "-h") &&
    args.length === 1
  ) {
    return { help: true };
  }

  const command = args[0];
  if (
    command === "providers" ||
    command === "validate" ||
    command === "run"
  ) {
    return { help: false, command };
  }

  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  let task: string | undefined;
  let pipeline: string | undefined;
  let port: number | undefined;
  let checkout: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--task") {
      task = args[++i];
    } else if (args[i] === "--pipeline") {
      pipeline = args[++i];
    } else if (args[i] === "--checkout") {
      const raw = args[++i];
      if (raw === undefined || raw.length === 0) {
        throw new Error("Missing value for --checkout");
      }
      checkout = raw;
    } else if (args[i] === "--port") {
      const raw = args[++i];
      port = Number(raw);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`Invalid --port: ${raw}`);
      }
    }
  }
  return { help: false, command, task, pipeline, port, checkout };
}

export function parseRunStageArgs(argv: string[]): {
  runId: string;
  stageId: string;
  mode?: "run" | "resume";
  resumeAnswer?: unknown;
  attempt?: number;
  sessionFilePath?: string;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
} {
  let runId: string | undefined;
  let stageId: string | undefined;
  let mode: "run" | "resume" | undefined;
  let resumeAnswer: unknown;
  let attempt: number | undefined;
  let sessionFilePath: string | undefined;
  let operatorAgentDir: string | undefined;
  let skipGates = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run-id") {
      runId = argv[++i];
    } else if (argv[i] === "--stage-id") {
      stageId = argv[++i];
    } else if (argv[i] === "--mode") {
      const raw = argv[++i];
      if (raw !== "run" && raw !== "resume") {
        throw new Error("--mode must be run or resume");
      }
      mode = raw;
    } else if (argv[i] === "--resume-answer") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("Missing value for --resume-answer");
      }
      try {
        resumeAnswer = JSON.parse(raw) as unknown;
      } catch {
        throw new Error("--resume-answer must be valid JSON");
      }
    } else if (argv[i] === "--attempt") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("Missing value for --attempt");
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--attempt must be a positive integer");
      }
      attempt = parsed;
    } else if (argv[i] === "--session-file") {
      sessionFilePath = argv[++i];
      if (sessionFilePath === undefined) {
        throw new Error("Missing value for --session-file");
      }
    } else if (argv[i] === "--operator-agent-dir") {
      operatorAgentDir = argv[++i];
      if (operatorAgentDir === undefined) {
        throw new Error("Missing value for --operator-agent-dir");
      }
    } else if (argv[i] === "--skip-gates") {
      skipGates = true;
    }
  }
  if (!runId || !stageId) {
    throw new Error("Missing --run-id and/or --stage-id");
  }
  return {
    runId,
    stageId,
    mode,
    resumeAnswer,
    attempt,
    sessionFilePath,
    skipGates,
    ...(operatorAgentDir !== undefined
      ? { operatorCatalog: { cwd: process.cwd(), agentDir: operatorAgentDir } }
      : {}),
  };
}

async function handleInternalRunStage(argv: string[]): Promise<number> {
  if (process.env[SF_STAGE_WORKER] !== "1") {
    process.env[SF_STAGE_WORKER] = "1";
  }
  const parsed = parseRunStageArgs(argv);
  const outcome = await runStageWorker({
    runId: parsed.runId,
    stageId: parsed.stageId,
    rootDir: process.cwd(),
    mode:
      parsed.mode ??
      (parsed.resumeAnswer !== undefined ? "resume" : "run"),
    resumeAnswer: parsed.resumeAnswer,
    attempt: parsed.attempt,
    sessionFilePath: parsed.sessionFilePath,
    operatorCatalog: parsed.operatorCatalog,
    skipGates: parsed.skipGates,
  });
  exitForOutcome(outcome);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(USAGE);
      return argv.slice(2).length === 0 ? 1 : 0;
    }

    const rootDir = process.cwd();

    if (parsed.command === "validate") {
      return runValidateCommand(argv.slice(3), { cwd: rootDir });
    }

    if (parsed.command === "run") {
      return runRunCommand(argv.slice(3), { cwd: rootDir });
    }

    if (parsed.command === "providers") {
      return runProvidersCommand(argv.slice(3), rootDir);
    }

    const store = createRunStore({ rootDir });

    if (parsed.command === "ui") {
      const { url, mcpUrl } = await startUiServer({
        agent: new PiAgentAdapter(),
        store,
        port: parsed.port,
      });
      console.log(`Operator console: ${url}`);
      console.log(`MCP endpoint: ${mcpUrl}`);
      openBrowser(url);
      await new Promise(() => undefined);
      return 0;
    }

    if (parsed.command === "internal") {
      const subArgs = argv.slice(3);
      const subcommand = subArgs[0];
      if (subcommand !== "run-stage") {
        console.error(`Unknown internal command: ${subcommand ?? "(none)"}`);
        return 1;
      }
      return handleInternalRunStage(subArgs.slice(1));
    }

    console.error(`Unknown command: ${parsed.command}`);
    console.error(USAGE);
    return 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function isDirectCliInvocation(): boolean {
  const self = fileURLToPath(import.meta.url);
  return process.argv.slice(1).some((arg) => {
    try {
      return path.resolve(arg) === self;
    } catch {
      return false;
    }
  });
}

if (isDirectCliInvocation()) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
