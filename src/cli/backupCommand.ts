import { globalStageflowHome } from "../project/globalHome.js";
import {
  BackupError,
  createBackup,
  defaultBackupOutPath,
} from "../runstore/backup.js";
import {
  createRunStoreAfterHostEnsure,
} from "../runstore/createStore.js";
import { ensureGlobalService } from "../server/ensureGlobalService.js";

export const BACKUP_USAGE = `Usage:
  sf backup [--out <file>] [--db-only] [--no-credentials] [--include-a2a-artifacts] [--json]

Creates a consistent snapshot of the Stageflow store. Default archives include
provider credentials (mode 0600) and must be treated as secrets.
Default --out is under $STAGEFLOW_HOME/backups/.`;

export type BackupCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: BackupCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedBackupArgs = {
  help: boolean;
  outPath?: string;
  dbOnly: boolean;
  noCredentials: boolean;
  includeA2aArtifacts: boolean;
  json: boolean;
};

function parseBackupArgs(args: string[]): ParsedBackupArgs {
  let help = false;
  let outPath: string | undefined;
  let dbOnly = false;
  let noCredentials = false;
  let includeA2aArtifacts = false;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--out") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --out");
      }
      outPath = value;
    } else if (arg === "--db-only") {
      dbOnly = true;
    } else if (arg === "--no-credentials") {
      noCredentials = true;
    } else if (arg === "--include-a2a-artifacts") {
      includeA2aArtifacts = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, outPath, dbOnly, noCredentials, includeA2aArtifacts, json };
}

export async function runBackupCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<BackupCommandIo>;
  } = {},
): Promise<number> {
  const out: BackupCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedBackupArgs;
  try {
    parsed = parseBackupArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(BACKUP_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(BACKUP_USAGE);
    return 0;
  }

  const home = globalStageflowHome();
  const opened = await createRunStoreAfterHostEnsure(
    { rootDir: home },
    () => ensureGlobalService(),
  );
  if (!opened.ok) {
    out.error(opened.message);
    return 1;
  }
  const store = opened.store;

  try {
    const result = await createBackup({
      store,
      homeDir: home,
      outPath:
        parsed.outPath ??
        defaultBackupOutPath(home, new Date(), parsed.dbOnly),
      dbOnly: parsed.dbOnly,
      noCredentials: parsed.noCredentials,
      includeA2aArtifacts: parsed.includeA2aArtifacts,
    });

    if (!parsed.dbOnly && !parsed.noCredentials) {
      out.error(
        "warning: backup may contain provider credentials — treat the file as a secret",
      );
    }

    if (parsed.json) {
      out.log(JSON.stringify(result));
    } else {
      out.log(`Wrote ${result.path} (${result.bytes} bytes, sha256=${result.sha256})`);
    }
    return 0;
  } catch (err) {
    if (err instanceof BackupError) {
      out.error(`${err.code}: ${err.message}`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    return 1;
  } finally {
    await store.close();
  }
}
