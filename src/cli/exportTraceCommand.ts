import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRun } from "../projection/projectRun.js";
import { createRunStore } from "../runstore/createStore.js";
import type { RunStatus } from "../runstore/port.js";
import { runWorkspaceDir, storeRootFor } from "../runstore/paths.js";
import {
  attemptSessionPath,
  isInsideDir,
} from "../runstore/workspaceLayout.js";

export const EXPORT_TRACE_USAGE = `Usage:
  sf export-trace --run <runId> [--from <sf-run.json>] [--instance-id <id>] [--out <file>] [--model <name>]`;

export type ExportTraceCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ExportTraceCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedExportTraceArgs = {
  help: boolean;
  runId?: string;
  fromPath?: string;
  outPath?: string;
  instanceId?: string;
  modelName?: string;
};

function parseExportTraceArgs(args: string[]): ParsedExportTraceArgs {
  if (args.length === 0) {
    return { help: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }

  let runId: string | undefined;
  let fromPath: string | undefined;
  let outPath: string | undefined;
  let instanceId: string | undefined;
  let modelName: string | undefined;
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
    } else if (arg === "--instance-id") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --instance-id");
      }
      instanceId = value;
    } else if (arg === "--model") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --model");
      }
      modelName = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, runId, fromPath, outPath, instanceId, modelName };
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
  const id = (parsed as { runId?: unknown }).runId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("--from file must contain a JSON object with runId");
  }
  return id;
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

function readJsonl(filePath: string): unknown[] {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      out.push({ raw: line });
    }
  }
  return out;
}

function readJsonIfExists(filePath: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function buildTraceDocument(input: {
  runId: string;
  runWorkspace: string;
  projection: ReturnType<typeof projectRun>;
  instanceId?: string;
  modelName?: string;
}): Record<string, unknown> {
  const stages: Record<string, unknown>[] = [];

  for (const stage of input.projection.stages) {
    const attempt = 1;
    const sessionPath = attemptSessionPath(
      input.runWorkspace,
      stage.stage_id,
      attempt,
    );
    const envelopePath = path.join(
      input.runWorkspace,
      "stages",
      stage.stage_id,
      "attempts",
      String(attempt),
      "envelope.json",
    );
    const stageTrace: Record<string, unknown> = {
      stage_id: stage.stage_id,
      attempt,
      pi_session_path: path.relative(input.runWorkspace, sessionPath),
    };
    const envelope = readJsonIfExists(envelopePath);
    if (envelope !== undefined) {
      stageTrace.envelope = envelope;
    } else if (stage.envelope) {
      stageTrace.envelope = stage.envelope;
    }
    try {
      stageTrace.pi_session = readJsonl(sessionPath);
    } catch {
      stageTrace.pi_session = [];
    }
    stages.push(stageTrace);
  }

  return {
    instance_id: input.instanceId ?? input.projection.task_id ?? input.runId,
    run_id: input.runId,
    pipeline: input.projection.pipeline_path,
    task: input.projection.task_path,
    model_name_or_path: input.modelName ?? "unknown",
    outcome: input.projection.status,
    stages,
  };
}

export async function runExportTraceCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<ExportTraceCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: ExportTraceCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedExportTraceArgs;
  try {
    parsed = parseExportTraceArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(EXPORT_TRACE_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(EXPORT_TRACE_USAGE);
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
    out.error(EXPORT_TRACE_USAGE);
    return 1;
  }

  const store = createRunStore({ rootDir: projectRoot });

  try {
    const detail = await store.readRun(runId);
    assertRunComplete(detail.status, runId);
    const projection = projectRun(detail);
    const runWorkspace = runWorkspaceDir(storeRootFor(projectRoot), runId);
    const document = buildTraceDocument({
      runId,
      runWorkspace,
      projection,
      instanceId: parsed.instanceId,
      modelName: parsed.modelName,
    });
    const json = JSON.stringify(document, null, 2);

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
