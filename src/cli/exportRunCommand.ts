import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRun } from "../projection/projectRun.js";
import { createRunStore } from "../runstore/createStore.js";
import type { RunStatus } from "../runstore/port.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";

export const EXPORT_RUN_USAGE = `Usage:
  sf export-run --run <runId> [--from <sf-run.json>] [--out <file>]`;

export type ExportRunCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ExportRunCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedExportRunArgs = {
  help: boolean;
  runId?: string;
  fromPath?: string;
  outPath?: string;
};

function parseExportRunArgs(args: string[]): ParsedExportRunArgs {
  if (args.length === 0) {
    return { help: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }

  let runId: string | undefined;
  let fromPath: string | undefined;
  let outPath: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--run") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --run");
      }
      runId = value;
    } else if (arg === "--from") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --from");
      }
      fromPath = value;
    } else if (arg === "--out") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --out");
      }
      outPath = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, runId, fromPath, outPath };
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

function resolveSafeOutPath(outPath: string, cwd: string): string {
  const segments = outPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("path must not contain .. segments");
  }
  const resolved = path.resolve(cwd, outPath);
  const cwdResolved = path.resolve(cwd);
  if (!isInsideDir(resolved, cwdResolved)) {
    throw new Error(
      "output path must resolve under the current working directory",
    );
  }
  return resolved;
}

function assertRunComplete(status: RunStatus, runId: string): void {
  if (status === "succeeded" || status === "failed") {
    return;
  }
  throw new Error(`run is not complete: ${runId} (status: ${status})`);
}

export async function runExportRunCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<ExportRunCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: ExportRunCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedExportRunArgs;
  try {
    parsed = parseExportRunArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(EXPORT_RUN_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(EXPORT_RUN_USAGE);
    return 0;
  }

  let runId = parsed.runId;
  if (parsed.fromPath !== undefined) {
    try {
      runId = resolveRunIdFromFile(parsed.fromPath, cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.error(message);
      return 1;
    }
  }

  if (!runId) {
    out.error("Missing --run (or --from <sf-run.json>)");
    out.error(EXPORT_RUN_USAGE);
    return 1;
  }

  const store = createRunStore({ rootDir: projectRoot });

  try {
    const detail = await store.readRun(runId);
    assertRunComplete(detail.status, runId);
    const projection = projectRun(detail);
    const json = JSON.stringify(projection, null, 2);

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
