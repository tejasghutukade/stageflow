import { readFileSync } from "node:fs";
import path from "node:path";
import { PiAgentAdapter } from "../agent/piAdapter.js";
import { projectRun } from "../projection/projectRun.js";
import { waitRun, type WaitUntil } from "../mcp/waitRun.js";
import { projectWaitingGates } from "../mcp/waitingGates.js";
import { resolveOperatorCatalog } from "./operatorCatalog.js";
import { completeCliRun } from "./runCommand.js";
import { reportCliRun, type CliRunReportIo } from "./runOutput.js";
import { createRunStore } from "../runstore/createStore.js";
import type { ListRunsFilter, RunStatus, RunStore } from "../runstore/port.js";
import { RunManager } from "../runtime/runManager.js";
import { readStageExecutionMode } from "../runtime/stageConcurrency.js";
import { DEFAULT_PORT } from "../server/createHttpHost.js";
import { mapRetryStageFailure } from "../server/operatorResults.js";
import {
  AskOperatorError,
  parseAskOperatorAnswer,
} from "../tools/askOperator.js";

export const RUNS_USAGE = `Usage:
  sf runs list [--status created|running|succeeded|failed] [--since <iso>] [--pipeline <id-or-path>] [--json]
  sf runs show --run <runId> [--from <sf-run.json>] [--json]
  sf runs waiting [--run <runId>] [--json]
  sf runs wait --run <runId> [--from <sf-run.json>] [--until any|waiting|terminal] [--timeout-ms <n>] [--json]
  sf runs answer --run <runId> --stage <stageId> [--answer '<json>'] [--json]
  sf runs retry --run <runId> --stage <stageId> [--json]
  sf runs abandon --run <runId> --stage <stageId> [--json]
  sf runs rerun --run <runId> [--json]`;

export type RunsCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type HostProbeResult = "up" | "down";

const defaultIo: RunsCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const RUN_STATUSES: readonly RunStatus[] = [
  "created",
  "running",
  "succeeded",
  "failed",
];

const LIST_FLAGS = new Set([
  "--status",
  "--since",
  "--pipeline",
  "--json",
  "--help",
  "-h",
]);
const SHOW_FLAGS = new Set(["--run", "--from", "--json", "--help", "-h"]);
const WAITING_FLAGS = new Set(["--run", "--json", "--help", "-h"]);
const WAIT_FLAGS = new Set([
  "--run",
  "--from",
  "--until",
  "--timeout-ms",
  "--json",
  "--help",
  "-h",
]);
const ANSWER_FLAGS = new Set([
  "--run",
  "--stage",
  "--answer",
  "--json",
  "--help",
  "-h",
]);
const RETRY_FLAGS = new Set(["--run", "--stage", "--json", "--help", "-h"]);
const ABANDON_FLAGS = new Set(["--run", "--stage", "--json", "--help", "-h"]);
const RERUN_FLAGS = new Set(["--run", "--json", "--help", "-h"]);

const VALUE_FLAGS = new Set([
  "--status",
  "--since",
  "--pipeline",
  "--run",
  "--from",
  "--until",
  "--timeout-ms",
  "--stage",
  "--answer",
]);

type ParsedRunsArgs = {
  help: boolean;
  json: boolean;
  subcommand?: string;
  status?: string;
  since?: string;
  pipeline?: string;
  runId?: string;
  fromPath?: string;
  until?: string;
  timeoutMs?: number;
  stageId?: string;
  answer?: string;
};

function flagsFor(subcommand: string): Set<string> | undefined {
  switch (subcommand) {
    case "list":
      return LIST_FLAGS;
    case "show":
      return SHOW_FLAGS;
    case "waiting":
      return WAITING_FLAGS;
    case "wait":
      return WAIT_FLAGS;
    case "answer":
      return ANSWER_FLAGS;
    case "retry":
      return RETRY_FLAGS;
    case "abandon":
      return ABANDON_FLAGS;
    case "rerun":
      return RERUN_FLAGS;
    default:
      return undefined;
  }
}

function parseRunsArgs(args: string[]): ParsedRunsArgs {
  if (args.length === 0) {
    return { help: false, json: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false };
  }

  const subcommand = args[0];
  const allowed = flagsFor(subcommand);
  if (allowed === undefined) {
    return { subcommand, help: false, json: false };
  }

  let help = false;
  let json = false;
  let status: string | undefined;
  let since: string | undefined;
  let pipeline: string | undefined;
  let runId: string | undefined;
  let fromPath: string | undefined;
  let until: string | undefined;
  let timeoutMs: number | undefined;
  let stageId: string | undefined;
  let answer: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (VALUE_FLAGS.has(arg)) {
      if (!allowed.has(arg)) {
        throw new Error(`Unknown flag: ${arg}`);
      }
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--status") status = value;
      else if (arg === "--since") since = value;
      else if (arg === "--pipeline") pipeline = value;
      else if (arg === "--run") runId = value;
      else if (arg === "--from") fromPath = value;
      else if (arg === "--until") until = value;
      else if (arg === "--timeout-ms") timeoutMs = Number(value);
      else if (arg === "--stage") stageId = value;
      else if (arg === "--answer") answer = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help,
    json,
    subcommand,
    status,
    since,
    pipeline,
    runId,
    fromPath,
    until,
    timeoutMs,
    stageId,
    answer,
  };
}

function resolveRunIdFromFile(fromPath: string, cwd: string): string {
  const resolved = path.resolve(cwd, fromPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read --from file: ${message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("--from file must contain a JSON object with runId");
  }
  const runId = (parsed as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("--from file must contain a JSON object with runId");
  }
  return runId;
}

function hostBaseUrl(): string {
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

export async function defaultProbeHost(): Promise<HostProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetch(`${hostBaseUrl()}/api/health`, {
      signal: ac.signal,
    });
    if (res.status !== 200) return "down";
    JSON.parse(await res.text());
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

function printJson(io: RunsCommandIo, payload: unknown): void {
  io.log(JSON.stringify(payload, null, 2));
}

function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

function isWaitUntil(value: string): value is WaitUntil {
  return value === "any" || value === "waiting" || value === "terminal";
}

function usageError(io: RunsCommandIo, message?: string): number {
  if (message !== undefined) io.error(message);
  io.error(RUNS_USAGE);
  return 1;
}

async function resolveShowWaitRunId(
  parsed: ParsedRunsArgs,
  cwd: string,
  io: RunsCommandIo,
): Promise<string | undefined> {
  if (parsed.fromPath !== undefined) {
    try {
      return resolveRunIdFromFile(parsed.fromPath, cwd);
    } catch (err) {
      io.error(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }
  return parsed.runId;
}

export async function runRunsCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    isGitProject?: boolean;
    io?: Partial<RunsCommandIo>;
    store?: RunStore;
    probeHost?: () => Promise<HostProbeResult>;
    stdinIsTTY?: boolean;
    readStdin?: () => string;
    waitSignal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    createManager?: (store: RunStore) => RunManager;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const isGitProject = options.isGitProject ?? false;
  const out: RunsCommandIo = { ...defaultIo, ...options.io };
  const env = options.env ?? process.env;
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const readStdin =
    options.readStdin ?? (() => readFileSync(0, "utf8"));
  const probeHost = options.probeHost ?? defaultProbeHost;

  let parsed: ParsedRunsArgs;
  try {
    parsed = parseRunsArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return usageError(out, message);
  }

  if (parsed.help) {
    out.error(RUNS_USAGE);
    return 0;
  }

  if (!parsed.subcommand) {
    return usageError(out);
  }

  let resolvedStore: RunStore | undefined = options.store;
  const getStore = (): RunStore => {
    if (resolvedStore === undefined) {
      resolvedStore = createRunStore({ rootDir: projectRoot });
    }
    return resolvedStore;
  };

  const mutatingIo: CliRunReportIo = out;

  const buildManager = (): RunManager => {
    const store = getStore();
    if (options.createManager) return options.createManager(store);
    const operatorCatalog = resolveOperatorCatalog({
      flags: {},
      env,
      defaultCwd: cwd,
    });
    return new RunManager({
      agent: new PiAgentAdapter(),
      store,
      cwd,
      projectRoot,
      isGitProject,
      operatorCatalog,
      executionMode: readStageExecutionMode(env, "process"),
    });
  };

  const guardHost = async (): Promise<number | undefined> => {
    const status = await probeHost();
    if (status === "up") {
      out.error(
        `A Stageflow host is already running at ${hostBaseUrl()}. Use the operator console or MCP instead of mutating the store from the CLI.`,
      );
      return 1;
    }
    return undefined;
  };

  switch (parsed.subcommand) {
    case "list": {
      if (parsed.status === "waiting") {
        out.error(
          "waiting is not a run status; parked HITL runs stay running. Use sf runs waiting.",
        );
        return 1;
      }
      if (parsed.status !== undefined && !isRunStatus(parsed.status)) {
        out.error(
          "--status must be created, running, succeeded, or failed",
        );
        return 1;
      }
      if (parsed.since !== undefined && !Number.isFinite(Date.parse(parsed.since))) {
        out.error("since must be a valid date");
        return 1;
      }
      const filter: ListRunsFilter = {};
      if (parsed.status !== undefined) filter.status = parsed.status;
      if (parsed.since !== undefined) filter.since = parsed.since;
      if (parsed.pipeline !== undefined) filter.pipeline = parsed.pipeline;
      const runs = await getStore().listRuns(
        Object.keys(filter).length > 0 ? filter : undefined,
      );
      if (parsed.json) {
        printJson(out, { runs });
      } else {
        for (const run of runs) {
          out.log(`${run.run_id}\t${run.status}`);
        }
      }
      return 0;
    }

    case "show": {
      const runId = await resolveShowWaitRunId(parsed, cwd, out);
      if (parsed.fromPath !== undefined && runId === undefined) {
        return 1;
      }
      if (!runId) {
        return usageError(out, "Missing --run (or --from <sf-run.json>)");
      }
      try {
        const detail = await getStore().readRun(runId);
        const projection = projectRun(detail);
        if (parsed.json) {
          printJson(out, projection);
        } else {
          out.log(`${projection.run_id}\t${projection.status}`);
        }
        return 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out.error(message);
        return 1;
      }
    }

    case "waiting": {
      const waiting = await projectWaitingGates(getStore(), {
        runId: parsed.runId,
      });
      if (parsed.json) {
        printJson(out, { waiting });
      } else {
        for (const item of waiting) {
          const runId = typeof item.runId === "string" ? item.runId : "";
          const stageId = typeof item.stageId === "string" ? item.stageId : "";
          out.log(`${runId}\t${stageId}`);
        }
      }
      return 0;
    }

    case "wait": {
      const runId = await resolveShowWaitRunId(parsed, cwd, out);
      if (parsed.fromPath !== undefined && runId === undefined) {
        return 1;
      }
      if (!runId) {
        return usageError(out, "Missing --run (or --from <sf-run.json>)");
      }
      const untilRaw = parsed.until ?? "any";
      if (!isWaitUntil(untilRaw)) {
        return usageError(
          out,
          "--until must be any, waiting, or terminal",
        );
      }

      let signal = options.waitSignal;
      let onSigInt: (() => void) | undefined;
      if (signal === undefined) {
        const controller = new AbortController();
        signal = controller.signal;
        onSigInt = () => controller.abort();
        process.once("SIGINT", onSigInt);
      }

      try {
        const result = await waitRun({
          store: getStore(),
          runId,
          timeoutMs: parsed.timeoutMs,
          until: untilRaw,
          signal,
        });
        if (!result.ok) {
          if (result.code === "aborted") {
            if (parsed.json) {
              printJson(out, { error: result.error, code: "aborted" });
            } else {
              out.error(result.error);
            }
            return 130;
          }
          if (parsed.json) {
            const payload: Record<string, unknown> = { error: result.error };
            if (result.status !== undefined) payload.status = result.status;
            printJson(out, payload);
          } else {
            out.error(result.error);
          }
          return 1;
        }
        if (parsed.json) {
          printJson(out, result);
        } else {
          out.log(`${result.reason}\t${result.run.status}`);
        }
        return 0;
      } finally {
        if (onSigInt !== undefined) {
          process.removeListener("SIGINT", onSigInt);
        }
      }
    }

    case "answer": {
      const blocked = await guardHost();
      if (blocked !== undefined) return blocked;
      if (!parsed.runId) {
        return usageError(out, "Missing --run");
      }
      if (!parsed.stageId) {
        return usageError(out, "Missing --stage");
      }
      let answerRaw = parsed.answer;
      if (answerRaw === undefined) {
        if (stdinIsTTY) {
          return usageError(
            out,
            "Missing --answer (pass --answer '<json>' or pipe JSON on stdin)",
          );
        }
        answerRaw = readStdin().trim();
        if (answerRaw.length === 0) {
          return usageError(
            out,
            "Missing --answer (pass --answer '<json>' or pipe JSON on stdin)",
          );
        }
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(answerRaw) as unknown;
      } catch {
        const message = "--answer must be valid JSON";
        if (parsed.json) {
          printJson(out, { error: message, status: 400 });
        } else {
          out.error(message);
        }
        return 1;
      }
      let answer;
      try {
        answer = parseAskOperatorAnswer(parsedJson);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof AskOperatorError) {
          if (parsed.json) {
            printJson(out, { error: message, status: 400 });
          } else {
            out.error(message);
          }
          return 1;
        }
        out.error(message);
        return 1;
      }
      const manager = buildManager();
      const result = await manager.deliverAnswer(
        parsed.runId,
        parsed.stageId,
        answer,
      );
      if (!result.ok) {
        const payload: Record<string, unknown> = { error: result.reason };
        if (result.status !== undefined) payload.status = result.status;
        if (parsed.json) {
          printJson(out, payload);
        } else {
          out.error(result.reason);
        }
        return 1;
      }
      if (parsed.json) {
        printJson(out, { ok: true });
      } else {
        out.log("ok");
      }
      return 0;
    }

    case "retry": {
      const blocked = await guardHost();
      if (blocked !== undefined) return blocked;
      if (!parsed.runId || !parsed.stageId) {
        return usageError(out, "Missing --run and/or --stage");
      }
      const manager = buildManager();
      const result = await manager.retryStageUntilStop(
        parsed.runId,
        parsed.stageId,
      );
      if (!result.ok) {
        if (parsed.json) {
          printJson(out, {
            ...mapRetryStageFailure(result),
            status: result.status,
          });
        } else {
          out.error(result.reason);
        }
        return 1;
      }
      return reportCliRun(
        { kind: "completion", result: result.pipeline },
        { json: parsed.json, io: mutatingIo },
      );
    }

    case "abandon": {
      const blocked = await guardHost();
      if (blocked !== undefined) return blocked;
      if (!parsed.runId || !parsed.stageId) {
        return usageError(out, "Missing --run and/or --stage");
      }
      const manager = buildManager();
      const result = await manager.abandonStage(parsed.runId, parsed.stageId);
      if (!result.ok) {
        const payload: Record<string, unknown> = { error: result.reason };
        if (result.status !== undefined) payload.status = result.status;
        if (parsed.json) {
          printJson(out, payload);
        } else {
          out.error(result.reason);
        }
        return 1;
      }
      if (parsed.json) {
        printJson(out, {
          ok: true,
          runId: result.runId,
          stageId: result.stageId,
        });
      } else {
        out.log(`${result.runId}\t${result.stageId}`);
      }
      return 0;
    }

    case "rerun": {
      const blocked = await guardHost();
      if (blocked !== undefined) return blocked;
      if (!parsed.runId) {
        return usageError(out, "Missing --run");
      }
      const manager = buildManager();
      const started = await manager.rerun(parsed.runId);
      if (!started.ok) {
        return reportCliRun(
          { kind: "start-failure", started },
          { json: parsed.json, io: mutatingIo },
        );
      }
      return completeCliRun(started, mutatingIo, {
        json: parsed.json,
        store: getStore(),
      });
    }

    default:
      return usageError(
        out,
        `Unknown runs subcommand: ${parsed.subcommand}`,
      );
  }
}
