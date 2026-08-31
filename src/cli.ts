#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiAgentAdapter } from "./agent/piAdapter.js";
import { ARTIFACT_USAGE, runArtifactCommand } from "./cli/artifactCommand.js";
import {
  ENVELOPE_USAGE,
  runEnvelopeCommand,
} from "./cli/envelopeCommand.js";
import {
  EXPORT_RUN_USAGE,
  runExportRunCommand,
} from "./cli/exportRunCommand.js";
import {
  EXPORT_TRACE_USAGE,
  runExportTraceCommand,
} from "./cli/exportTraceCommand.js";
import { INIT_USAGE, runInitCommand } from "./cli/initCommand.js";
import { PROVIDERS_USAGE, runProvidersCommand } from "./cli/providersCommand.js";
import { RUN_USAGE, runRunCommand } from "./cli/runCommand.js";
import { resolveOperatorCatalog } from "./cli/operatorCatalog.js";
import { SKILLS_USAGE, runSkillsCommand } from "./cli/skillsCommand.js";
import { VALIDATE_USAGE, runValidateCommand } from "./cli/validateCommand.js";
import { createRunStore } from "./runstore/createStore.js";
import { resolveStageflowContext } from "./project/resolveStageflowContext.js";
import { exitForOutcome, runStageWorker } from "./runtime/stageWorker.js";
import { SF_STAGE_WORKER } from "./runtime/stageWorkerProtocol.js";
import type { OperatorCatalog } from "./runtime/stageAttemptBootstrap.js";
import { DEFAULT_PORT, startUiServer } from "./server/http.js";

const USAGE = `Usage:
  sf init
  sf run --task <path> --pipeline <path> [--checkout <path>] [--json] [--include stages] [--skip-gates] [--git-sha <sha>] [--ci-pr-url <url>] [--ci-job-url <url>] [--operator-cwd <path>] [--operator-agent-dir <path>]
  sf validate [--pipeline <path>] [--task <path>] [--strict] [--json]
  sf artifact read --run <runId> --path <relPath> [--out <file>]
  sf envelope get --run <runId> --stage <stageId> [--json] [--from <sf-run.json>] [--detect-stage <id>] [--format envelope|handoff]
  sf export-run --run <runId> [--from <sf-run.json>] [--out <file>]
  sf export-trace --run <runId> [--from <sf-run.json>] [--instance-id <id>] [--out <file>] [--model <name>]
  sf ui [--port ${DEFAULT_PORT}]
  sf providers list
  sf providers status [--provider <id>]
  sf providers detect
  sf providers source [get | set <pi_home|sf_owned>]
  sf providers login <providerId> [--type api_key|oauth] [--api-key-env <VAR>]
  sf providers logout <providerId>
  sf skills list
  sf skills install --from-path <dir> [--skill-name <name>]
  sf skills install --from-zip <url-or-path> [--skill-name <name>] [--checksum sha256:<hex>]
  sf --help

Stageflow (sf) runs YAML-defined automatic stage pipelines.

Store backend: SF_STORE=sqlite only. SF_STORE=disk is rejected; disk-era .stageflow/runs trees import when the SQLite store is empty. Data under .stageflow/.

${INIT_USAGE}

${RUN_USAGE}

${VALIDATE_USAGE}

${ARTIFACT_USAGE}

${ENVELOPE_USAGE}

${EXPORT_RUN_USAGE}

${EXPORT_TRACE_USAGE}

${PROVIDERS_USAGE}

${SKILLS_USAGE}`;

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
    command === "run" ||
    command === "init" ||
    command === "artifact" ||
    command === "envelope" ||
    command === "export-run" ||
    command === "export-trace" ||
    command === "skills"
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
  let operatorCwd: string | undefined;
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
    } else if (argv[i] === "--operator-cwd") {
      operatorCwd = argv[++i];
      if (operatorCwd === undefined) {
        throw new Error("Missing value for --operator-cwd");
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
  const operatorCatalog = resolveOperatorCatalog({
    flags: { operatorCwd, operatorAgentDir },
    env: process.env,
    defaultCwd: process.cwd(),
  });
  return {
    runId,
    stageId,
    mode,
    resumeAnswer,
    attempt,
    sessionFilePath,
    skipGates,
    operatorCatalog,
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

    const ctx = await resolveStageflowContext(process.cwd());

    if (parsed.command === "init") {
      return runInitCommand(argv.slice(3), { cwd: ctx.invocationCwd });
    }

    if (parsed.command === "validate") {
      return runValidateCommand(argv.slice(3), { cwd: ctx.invocationCwd });
    }

    if (parsed.command === "run") {
      return runRunCommand(argv.slice(3), {
        cwd: ctx.invocationCwd,
        projectRoot: ctx.projectRoot,
        isGitProject: ctx.isGitProject,
      });
    }

    if (parsed.command === "artifact") {
      return runArtifactCommand(argv.slice(3), {
        cwd: ctx.invocationCwd,
        projectRoot: ctx.projectRoot,
      });
    }

    if (parsed.command === "envelope") {
      return runEnvelopeCommand(argv.slice(3), {
        cwd: ctx.invocationCwd,
        projectRoot: ctx.projectRoot,
      });
    }

    if (parsed.command === "export-run") {
      return runExportRunCommand(argv.slice(3), {
        cwd: ctx.invocationCwd,
        projectRoot: ctx.projectRoot,
      });
    }

    if (parsed.command === "export-trace") {
      return runExportTraceCommand(argv.slice(3), {
        cwd: ctx.invocationCwd,
        projectRoot: ctx.projectRoot,
      });
    }

    if (parsed.command === "providers") {
      return runProvidersCommand(argv.slice(3), ctx.invocationCwd);
    }

    if (parsed.command === "skills") {
      return runSkillsCommand(argv.slice(3), {
        cwd: ctx.invocationCwd,
        projectRoot: ctx.projectRoot,
      });
    }

    const store = createRunStore({ rootDir: ctx.projectRoot });

    if (parsed.command === "ui") {
      const { url, mcpUrl } = await startUiServer({
        agent: new PiAgentAdapter(),
        store,
        cwd: ctx.invocationCwd,
        rootDir: ctx.projectRoot,
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

function normalizeCliEntry(filePath: string): string {
  const resolved = path.resolve(filePath);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  return canonical.replace(/\.(?:[cm]?[jt]s)$/i, "");
}

export function sameCliEntry(a: string, b: string): boolean {
  return normalizeCliEntry(a) === normalizeCliEntry(b);
}

function isDirectCliInvocation(): boolean {
  const self = fileURLToPath(import.meta.url);
  return process.argv.slice(1).some((arg) => sameCliEntry(arg, self));
}

if (isDirectCliInvocation()) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
