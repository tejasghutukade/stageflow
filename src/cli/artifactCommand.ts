import { writeFileSync } from "node:fs";
import path from "node:path";
import { readRunArtifact } from "../mcp/readArtifact.js";
import { createRunStore } from "../runstore/createStore.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";

export const ARTIFACT_USAGE = `Usage:
  sf artifact read --run <runId> --path <relPath> [--out <file>]`;

export type ArtifactCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ArtifactCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedArtifactArgs = {
  help: boolean;
  subcommand?: string;
  runId?: string;
  artifactPath?: string;
  outPath?: string;
};

function parseArtifactArgs(args: string[]): ParsedArtifactArgs {
  if (args.length === 0) {
    return { help: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }

  const subcommand = args[0];
  if (subcommand !== "read") {
    throw new Error(`Unknown artifact subcommand: ${subcommand}`);
  }

  let runId: string | undefined;
  let artifactPath: string | undefined;
  let outPath: string | undefined;
  let help = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--run") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --run");
      }
      runId = value;
    } else if (arg === "--path") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --path");
      }
      artifactPath = value;
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

  return { help, subcommand, runId, artifactPath, outPath };
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

export async function runArtifactCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<ArtifactCommandIo>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;
  const out: ArtifactCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedArtifactArgs;
  try {
    parsed = parseArtifactArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(ARTIFACT_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(ARTIFACT_USAGE);
    return 0;
  }

  if (parsed.subcommand !== "read") {
    out.error("Missing artifact subcommand");
    out.error(ARTIFACT_USAGE);
    return 1;
  }

  if (!parsed.runId || !parsed.artifactPath) {
    out.error("Missing --run and/or --path");
    out.error(ARTIFACT_USAGE);
    return 1;
  }

  const store = createRunStore({ rootDir: projectRoot });

  try {
    const contents = await readRunArtifact(
      store,
      parsed.runId,
      parsed.artifactPath,
    );

    if (parsed.outPath !== undefined) {
      const target = resolveSafeOutPath(parsed.outPath, cwd);
      writeFileSync(target, contents, "utf8");
      out.error(`Wrote ${target}`);
    } else {
      out.log(contents);
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    return 1;
  }
}
