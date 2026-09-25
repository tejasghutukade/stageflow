import { writeFileSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import { createRunStoreAfterHostEnsure } from "../runstore/createStore.js";
import { buildDebugBundle } from "../runstore/debugBundle.js";
import type { RunStatus } from "../runstore/port.js";
import { ensureGlobalService } from "../server/ensureGlobalService.js";
import { resolveSafeOutPath } from "./resolveSafeOutPath.js";

export const DEBUG_RUN_USAGE = `Usage:
  sf debug-run <runId> [--out <file>]`;

export type DebugRunCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: DebugRunCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedDebugRunArgs = {
  help: boolean;
  runId?: string;
  outPath?: string;
};

function parseDebugRunArgs(args: string[]): ParsedDebugRunArgs {
  if (args.length === 0) {
    return { help: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }

  let runId: string | undefined;
  let outPath: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--out") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --out");
      }
      outPath = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (runId === undefined) {
      runId = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, runId, outPath };
}

const DEBUGABLE_STATUSES = new Set<RunStatus>([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "queued",
  "created",
]);

function assertRunDebugable(status: RunStatus, runId: string): void {
  if (DEBUGABLE_STATUSES.has(status)) {
    return;
  }
  throw new Error(`run cannot be debugged: ${runId} (status: ${status})`);
}

export async function runDebugRunCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<DebugRunCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: DebugRunCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedDebugRunArgs;
  try {
    parsed = parseDebugRunArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(DEBUG_RUN_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(DEBUG_RUN_USAGE);
    return 0;
  }

  if (!parsed.runId) {
    out.error("Missing <runId>");
    out.error(DEBUG_RUN_USAGE);
    return 1;
  }

  const opened = await createRunStoreAfterHostEnsure(
    { rootDir: globalStageflowHome() },
    () => ensureGlobalService(),
  );
  if (!opened.ok) {
    out.error(opened.message);
    return 1;
  }
  const store = opened.store;

  try {
    const detail = await store.readRun(parsed.runId);
    assertRunDebugable(detail.status, parsed.runId);
    const bundle = await buildDebugBundle(store, parsed.runId);
    const json = JSON.stringify(bundle, null, 2);

    if (parsed.outPath !== undefined) {
      const target = resolveSafeOutPath(parsed.outPath, cwd);
      writeFileSync(target, json, "utf8");
      out.error(`Wrote ${target}`);
    } else {
      out.log(json);
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    return 1;
  }
}
