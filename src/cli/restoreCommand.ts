import path from "node:path";
import {
  applyRestoreArchive,
  RestoreError,
} from "../runstore/restore.js";
import { StoreSchemaError } from "../runstore/sqlite/storeSchemaError.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { probeGlobalServiceDetailed } from "../server/ensureGlobalService.js";

export const RESTORE_USAGE = `Usage:
  sf restore <file> [--force] [--json]

Restores a Stageflow backup. The Host must be down (probed via /livez).
Never autostarts a Host. Previous state.db is moved aside, not deleted.`;

export type RestoreCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: RestoreCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedRestoreArgs = {
  help: boolean;
  file?: string;
  force: boolean;
  json: boolean;
};

function parseRestoreArgs(args: string[]): ParsedRestoreArgs {
  let help = false;
  let file: string | undefined;
  let force = false;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, file, force, json };
}

export async function runRestoreCommand(
  args: string[],
  options: {
    io?: Partial<RestoreCommandIo>;
    probe?: typeof probeGlobalServiceDetailed;
  } = {},
): Promise<number> {
  const out: RestoreCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedRestoreArgs;
  try {
    parsed = parseRestoreArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(RESTORE_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(RESTORE_USAGE);
    return 0;
  }

  if (!parsed.file) {
    out.error("Missing <file>");
    out.error(RESTORE_USAGE);
    return 1;
  }

  try {
    const result = await applyRestoreArchive({
      archivePath: path.resolve(parsed.file),
      homeDir: globalStageflowHome(),
      force: parsed.force,
      probe: options.probe,
    });
    if (parsed.json) {
      out.log(JSON.stringify({ ok: true, ...result }));
    } else {
      out.log(
        `Restored schema_version=${result.schema_version}` +
          (result.missing_a2a_artifact_rows > 0
            ? ` (missing A2A artifact bytes: ${result.missing_a2a_artifact_rows})`
            : ""),
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof RestoreError || err instanceof StoreSchemaError) {
      out.error(`${err.code}: ${err.message}`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    return 1;
  }
}
