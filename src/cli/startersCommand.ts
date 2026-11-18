import { readdir } from "node:fs/promises";
import path from "node:path";
import { STARTERS_DIR } from "../project/starters.js";
import { workspaceCatalogPath } from "../project/workspaceCatalog.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { provisionStartersFromCli } from "./provisionStarters.js";

export const STARTERS_USAGE = `Usage:
  sf starters list [--json]
  sf starters install

List or install workspace starter pipelines (copied once into $STAGEFLOW_HOME/workspace/starters/ when a provider is connected).`;

type ParsedStartersArgs = {
  help: boolean;
  json: boolean;
  subcommand?: string;
};

function parseStartersArgs(args: string[]): ParsedStartersArgs {
  if (args.length === 0) return { help: false, json: false };
  if (args[0] === "--help" || args[0] === "-h") return { help: true, json: false };
  let json = false;
  let i = 1;
  const subcommand = args[0];
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") return { help: true, json };
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { help: false, json, subcommand };
}

async function listStarterNames(workspacePath: string): Promise<string[]> {
  const root = path.join(workspacePath, STARTERS_DIR);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export type StartersCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: StartersCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runStartersCommand(
  args: string[],
  options: { cwd?: string; io?: Partial<StartersCommandIo> } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: StartersCommandIo = { ...defaultIo, ...options.io };
  try {
    const parsed = parseStartersArgs(args);
    if (parsed.help || !parsed.subcommand) {
      out.error(STARTERS_USAGE);
      return parsed.help ? 0 : 1;
    }
    const workspacePath = workspaceCatalogPath();
    if (parsed.subcommand === "list") {
      const names = await listStarterNames(workspacePath);
      if (parsed.json) {
        out.log(
          JSON.stringify(
            { workspacePath, startersDir: path.join(workspacePath, STARTERS_DIR), names },
            null,
            2,
          ),
        );
      } else if (names.length === 0) {
        out.log(
          `No starters under ${path.join(workspacePath, STARTERS_DIR)}. Run \`sf starters install\` after connecting a provider.`,
        );
      } else {
        for (const name of names) out.log(name);
      }
      return 0;
    }
    if (parsed.subcommand === "install") {
      const result = await provisionStartersFromCli(cwd);
      if (parsed.json) {
        out.log(JSON.stringify(result, null, 2));
      } else if (result.installed) {
        out.log(
          `Installed ${result.files.length} starter file(s) under ${path.join(result.workspacePath, STARTERS_DIR)}`,
        );
      } else {
        out.log(
          `No new starter files installed (already present or no provider connected). Workspace: ${result.workspacePath}`,
        );
      }
      return 0;
    }
    out.error(`Unknown starters subcommand: ${parsed.subcommand}`);
    out.error(STARTERS_USAGE);
    return 1;
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    out.error(STARTERS_USAGE);
    return 1;
  }
}