import { completeCliRun } from "./runCommand.js";
import { reportCliRun, writeQueuedAdmissionLine, type CliRunReportIo } from "./runOutput.js";
import {
  ensureGlobalService,
  hostBaseUrl,
  type EnsureGlobalServiceResult,
} from "../server/ensureGlobalService.js";
import {
  httpFireTrigger,
  httpGetTrigger,
  httpListTriggers,
} from "./hostClient.js";

export const TRIGGER_USAGE = `Usage:
  sf trigger list [--json]
  sf trigger show <id> [--json]
  sf trigger fire <id> [--task-inline '<json>'] [--json]`;

export type TriggerCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: TriggerCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedTriggerArgs = {
  help: boolean;
  json: boolean;
  subcommand?: string;
  id?: string;
  taskInline?: string;
};

function parseTriggerArgs(args: string[]): ParsedTriggerArgs {
  if (args.length === 0) {
    return { help: false, json: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false };
  }

  const subcommand = args[0];
  let help = false;
  let json = false;
  let id: string | undefined;
  let taskInline: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--task-inline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --task-inline");
      }
      taskInline = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (id === undefined) {
      id = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, json, subcommand, id, taskInline };
}

function parseJsonFlag(raw: string, flagName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${flagName} must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function printJson(io: TriggerCommandIo, payload: unknown): void {
  io.log(JSON.stringify(payload, null, 2));
}

function usageError(io: TriggerCommandIo, message?: string): number {
  if (message !== undefined) io.error(message);
  io.error(TRIGGER_USAGE);
  return 1;
}

export async function runTriggerCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<TriggerCommandIo>;
    hostBaseUrl?: string;
    ensureService?: () => Promise<EnsureGlobalServiceResult>;
  } = {},
): Promise<number> {
  const out: TriggerCommandIo = { ...defaultIo, ...options.io };
  const base = options.hostBaseUrl ?? hostBaseUrl();
  const ensureService = options.ensureService ?? (() => ensureGlobalService());

  let parsed: ParsedTriggerArgs;
  try {
    parsed = parseTriggerArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return usageError(out, message);
  }

  if (parsed.help) {
    out.error(TRIGGER_USAGE);
    return 0;
  }

  if (!parsed.subcommand) {
    return usageError(out);
  }

  if (
    parsed.subcommand !== "list" &&
    parsed.subcommand !== "show" &&
    parsed.subcommand !== "fire"
  ) {
    return usageError(out, `Unknown trigger subcommand: ${parsed.subcommand}`);
  }

  const ensured = await ensureService();
  if (!ensured.ok) {
    if (parsed.json) {
      printJson(out, { error: ensured.message, reason: ensured.reason });
    } else {
      out.error(ensured.message);
    }
    return 1;
  }

  const mutatingIo: CliRunReportIo = out;

  switch (parsed.subcommand) {
    case "list": {
      const result = await httpListTriggers(base);
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
        printJson(out, { triggers: result.triggers });
      } else {
        for (const trigger of result.triggers) {
          out.log(`${trigger.id}\t${trigger.kind}\t${trigger.enabled}`);
        }
      }
      return 0;
    }

    case "show": {
      if (!parsed.id) {
        return usageError(out, "Missing <id>");
      }
      const result = await httpGetTrigger(base, parsed.id);
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
        printJson(out, result.trigger);
      } else {
        out.log(`${result.trigger.id}\t${result.trigger.kind}\t${result.trigger.enabled}`);
      }
      return 0;
    }

    case "fire": {
      if (!parsed.id) {
        return usageError(out, "Missing <id>");
      }
      let task: Record<string, unknown> | undefined;
      if (parsed.taskInline !== undefined) {
        try {
          task = parseJsonFlag(parsed.taskInline, "--task-inline");
        } catch (err) {
          out.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }
      const started = await httpFireTrigger(base, parsed.id, task);
      if (!started.ok) {
        return reportCliRun(
          { kind: "start-failure", started },
          { json: parsed.json, io: mutatingIo },
        );
      }
      writeQueuedAdmissionLine(started, mutatingIo);
      return completeCliRun(started, mutatingIo, { json: parsed.json });
    }

    default:
      return usageError(
        out,
        `Unknown trigger subcommand: ${parsed.subcommand}`,
      );
  }
}
