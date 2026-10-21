import { createWriteStream } from "node:fs";
import path from "node:path";
import { projectRun } from "../projection/projectRun.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  createRunStoreAfterHostEnsure,
} from "../runstore/createStore.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";
import { ensureGlobalService } from "../server/ensureGlobalService.js";

export const EXPORT_ALL_USAGE = `Usage:
  sf export --all [--status <status>] [--since <iso>] [--pipeline <id-or-path>] [--out <file>]

Streams whole-instance NDJSON (header + one projectRun line per run, including
non-terminal). Not a backup — restore does not accept export streams.`;

export type ExportAllCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ExportAllCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export type ExportHeader = {
  type: "stageflow_export";
  version: 1;
  stageflow_version: string;
  created_at: string;
  filter?: ListRunsFilter;
};

export type ExportPipelineSource =
  | { kind: "path"; path: string; pipeline: null }
  | { kind: "inline"; pipeline: unknown }
  | { kind: "unavailable"; pipeline: null; note: string };

export type ExportRunLine = {
  type: "projectRun";
  run: ReturnType<typeof projectRun> & {
    pipeline_source: ExportPipelineSource;
  };
};

export function buildExportHeader(
  filter?: ListRunsFilter,
  now: Date = new Date(),
): ExportHeader {
  return {
    type: "stageflow_export",
    version: 1,
    stageflow_version: PACKAGE_VERSION,
    created_at: now.toISOString(),
    ...(filter !== undefined ? { filter } : {}),
  };
}

export function resolveExportPipelineSource(options: {
  pipelineSource?: "inline" | "path";
  pipelinePath?: string;
  pipelineBody?: string | null;
}): ExportPipelineSource {
  if (options.pipelineSource === "inline") {
    if (options.pipelineBody != null && options.pipelineBody !== "") {
      try {
        return {
          kind: "inline",
          pipeline: JSON.parse(options.pipelineBody) as unknown,
        };
      } catch {
        return {
          kind: "unavailable",
          pipeline: null,
          note: "pipeline_body is not valid JSON",
        };
      }
    }
    return {
      kind: "unavailable",
      pipeline: null,
      note: "inline pipeline body missing",
    };
  }
  if (options.pipelineSource === "path" || options.pipelinePath) {
    return {
      kind: "path",
      path: options.pipelinePath ?? "",
      pipeline: null,
    };
  }
  return {
    kind: "unavailable",
    pipeline: null,
    note: "pipeline source not recorded",
  };
}

export function projectRunForExport(
  detail: Parameters<typeof projectRun>[0],
  pipelineBody?: string | null,
): ExportRunLine["run"] {
  return {
    ...projectRun(detail),
    pipeline_source: resolveExportPipelineSource({
      pipelineSource: detail.pipeline_source,
      pipelinePath: detail.pipeline_path,
      pipelineBody,
    }),
  };
}

export function assertExportOutPathAllowed(
  outPath: string,
  homeDir: string = globalStageflowHome(),
  cwd: string = process.cwd(),
): string {
  const segments = outPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("path must not contain .. segments");
  }
  const resolved = path.isAbsolute(outPath)
    ? path.resolve(outPath)
    : path.resolve(cwd, outPath);
  const worktrees = path.resolve(homeDir, "worktrees");
  const runs = path.resolve(homeDir, "runs");
  if (isInsideDir(resolved, worktrees) || isInsideDir(resolved, runs)) {
    throw new Error("output path must not be under worktrees/ or runs/");
  }
  return resolved;
}

type ParsedExportArgs = {
  help: boolean;
  all: boolean;
  status?: RunStatus;
  since?: string;
  pipeline?: string;
  outPath?: string;
};

function parseExportArgs(args: string[]): ParsedExportArgs {
  let help = false;
  let all = false;
  let status: RunStatus | undefined;
  let since: string | undefined;
  let pipeline: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--status") {
      const value = args[++i];
      if (value === undefined) throw new Error("Missing value for --status");
      status = value as RunStatus;
    } else if (arg === "--since") {
      const value = args[++i];
      if (value === undefined) throw new Error("Missing value for --since");
      since = value;
    } else if (arg === "--pipeline") {
      const value = args[++i];
      if (value === undefined) throw new Error("Missing value for --pipeline");
      pipeline = value;
    } else if (arg === "--out") {
      const value = args[++i];
      if (value === undefined) throw new Error("Missing value for --out");
      outPath = value;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, all, status, since, pipeline, outPath };
}

export async function* iterateExportNdjson(options: {
  store: {
    listRuns: (filter?: ListRunsFilter) => Promise<
      Array<{ run_id: string }>
    >;
    readRun: (runId: string) => Promise<Parameters<typeof projectRun>[0]>;
    readPipelineBody: (runId: string) => Promise<string | null>;
  };
  filter?: ListRunsFilter;
  now?: Date;
}): AsyncGenerator<string> {
  yield `${JSON.stringify(buildExportHeader(options.filter, options.now ?? new Date()))}\n`;
  const runs = await options.store.listRuns(options.filter);
  for (const summary of runs) {
    const detail = await options.store.readRun(summary.run_id);
    const pipelineBody = await options.store.readPipelineBody(summary.run_id);
    const line: ExportRunLine = {
      type: "projectRun",
      run: projectRunForExport(detail, pipelineBody),
    };
    yield `${JSON.stringify(line)}\n`;
  }
}

export async function runExportAllCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<ExportAllCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: ExportAllCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedExportArgs;
  try {
    parsed = parseExportArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(EXPORT_ALL_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(EXPORT_ALL_USAGE);
    return 0;
  }

  if (!parsed.all) {
    out.error("sf export requires --all (whole-instance NDJSON)");
    out.error(EXPORT_ALL_USAGE);
    return 1;
  }

  const filter: ListRunsFilter = {};
  if (parsed.status !== undefined) filter.status = parsed.status;
  if (parsed.since !== undefined) filter.since = parsed.since;
  if (parsed.pipeline !== undefined) filter.pipeline = parsed.pipeline;

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
    let sink: (line: string) => void = (line) => out.log(line.replace(/\n$/, ""));
    let close: (() => Promise<void>) | undefined;
    if (parsed.outPath !== undefined) {
      const target = assertExportOutPathAllowed(
        parsed.outPath,
        globalStageflowHome(),
        cwd,
      );
      const stream = createWriteStream(target);
      sink = (line) => {
        stream.write(line);
      };
      close = () =>
        new Promise((resolve, reject) => {
          stream.end(() => resolve());
          stream.on("error", reject);
        });
    }

    for await (const line of iterateExportNdjson({
      store,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    })) {
      sink(line);
    }
    await close?.();
    if (parsed.outPath !== undefined) {
      out.error(`Wrote ${assertExportOutPathAllowed(parsed.outPath, globalStageflowHome(), cwd)}`);
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    return 1;
  } finally {
    await store.close();
  }
}
