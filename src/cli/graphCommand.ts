import {
  loadPipelineValidated as defaultLoadPipelineValidated,
  type LoadPipelineValidatedResult,
} from "../config/validateCatalog.js";
import { formatValidationHuman, formatValidationJson } from "./validateOutput.js";
import { formatGraphHuman, formatGraphJson } from "./graphOutput.js";

export const GRAPH_USAGE = `Usage:
  sf graph --pipeline <path> [--json]

  Prints a definition-time view of the pipeline's graph shape (stages,
  route edges, entry, Clone Chain fan-out, loop send_back) before any run.
  --pipeline is required (includes uses:/include: transitively).
  --json dumps the resolved DAG on success; on load/validation failure it
  prints validate-shaped JSON to stdout (same shape as sf validate --json).`;

export const MISSING_PIPELINE_MESSAGE = "Missing required --pipeline <path>";

export type GraphCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: GraphCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export type ParsedGraphArgs = {
  help: boolean;
  pipeline?: string;
  json: boolean;
};

export function parseGraphArgs(args: string[]): ParsedGraphArgs {
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, json: false };
  }

  let pipeline: string | undefined;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
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

  if (!help && pipeline === undefined) {
    throw new Error(MISSING_PIPELINE_MESSAGE);
  }

  return { help, pipeline, json };
}

export async function runGraphCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<GraphCommandIo>;
    loadPipelineValidated?: (
      nameOrPath: string,
      opts: { cwd?: string; projectRoot?: string },
    ) => Promise<LoadPipelineValidatedResult>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: GraphCommandIo = { ...defaultIo, ...options.io };
  const loadPipelineValidatedFn = options.loadPipelineValidated ?? defaultLoadPipelineValidated;

  try {
    const parsed = parseGraphArgs(args);
    if (parsed.help) {
      out.error(GRAPH_USAGE);
      return 0;
    }

    const result = await loadPipelineValidatedFn(parsed.pipeline!, { cwd, projectRoot });

    if (!result.ok) {
      const validation = {
        scope: "pipeline" as const,
        ok: false,
        summary: {
          errors: result.findings.filter((f) => f.severity === "error").length,
          warnings: result.findings.filter((f) => f.severity === "warning").length,
        },
        findings: result.findings,
      };
      if (parsed.json) {
        out.log(formatValidationJson(validation));
      } else {
        out.error(formatValidationHuman(validation, {}));
      }
      return 1;
    }

    if (parsed.json) {
      out.log(formatGraphJson(result.loaded.dag));
    } else {
      out.log(formatGraphHuman(result.loaded, { path: parsed.pipeline }));
    }

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
