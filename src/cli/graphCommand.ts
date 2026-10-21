import type { LoadedPipeline } from "../types/pipeline.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { renderGraph } from "./graphRender.js";

export const GRAPH_USAGE = `Usage:
  sf graph --pipeline <path> [--json]

  Prints a definition-time view of how a pipeline graph is wired, before any run.
  --pipeline loads and resolves the pipeline (same resolution as sf validate / sf run).
  --json dumps the resolved DAG as JSON instead of the terminal diagram.`;

export type GraphCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: GraphCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedGraphArgs = {
  help: boolean;
  pipeline?: string;
  json: boolean;
};

function parseGraphArgs(args: string[]): ParsedGraphArgs {
  if (args.length === 0) {
    return { help: false, json: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false };
  }

  let pipeline: string | undefined;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pipeline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --pipeline");
      }
      pipeline = value;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, pipeline, json };
}

export async function runGraphCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<GraphCommandIo>;
    loadPipeline?: (
      nameOrPath: string,
      opts: { cwd?: string; projectRoot?: string },
    ) => Promise<LoadedPipeline>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: GraphCommandIo = { ...defaultIo, ...options.io };
  const loadPipelineFn = options.loadPipeline ?? loadPipeline;

  try {
    const parsed = parseGraphArgs(args);
    if (parsed.help) {
      out.error(GRAPH_USAGE);
      return 0;
    }
    if (parsed.pipeline === undefined) {
      throw new Error("Missing value for --pipeline");
    }

    const loaded = await loadPipelineFn(parsed.pipeline, { cwd, projectRoot });

    if (parsed.json) {
      out.log(JSON.stringify(loaded.dag, null, 2));
      return 0;
    }
    out.log(renderGraph(loaded.dag));
    return 0;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Graph command failed";
    out.error(message);
    out.error(GRAPH_USAGE);
    return 1;
  }
}
