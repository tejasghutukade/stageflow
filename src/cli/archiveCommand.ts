import { ArchiveError, buildArchive } from "../archive/build.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { BackupError } from "../runstore/backup.js";
import { createRunStoreAfterHostEnsure } from "../runstore/createStore.js";
import { ensureGlobalService } from "../server/ensureGlobalService.js";

export const ARCHIVE_USAGE = `Usage:
  sf archive [--out <file>] [--include-secrets] [--include-a2a-artifacts] [--json]

Writes one tar.gz of everything this Host keeps: the run store, settings, the workspace
catalog, memories, connections, MCP servers, agent transcripts, identity and run files,
with a manifest listing every file and everything left out. Secrets (provider credentials,
channel and MCP secrets) are left out unless you pass --include-secrets; an archive made
with them must be treated as a secret. Default --out is under $STAGEFLOW_HOME/backups/.`;

export type ArchiveCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ArchiveCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedArchiveArgs = {
  help: boolean;
  outPath?: string;
  includeSecrets: boolean;
  includeA2aArtifacts: boolean;
  json: boolean;
};

function parseArchiveArgs(args: string[]): ParsedArchiveArgs {
  const parsed: ParsedArchiveArgs = { help: false, includeSecrets: false, includeA2aArtifacts: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--out") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --out");
      parsed.outPath = value;
    } else if (arg === "--include-secrets") parsed.includeSecrets = true;
    else if (arg === "--include-a2a-artifacts") parsed.includeA2aArtifacts = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg?.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return parsed;
}

export async function runArchiveCommand(args: string[], options: { io?: Partial<ArchiveCommandIo> } = {}): Promise<number> {
  const out: ArchiveCommandIo = { ...defaultIo, ...options.io };

  let parsed: ParsedArchiveArgs;
  try {
    parsed = parseArchiveArgs(args);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    out.error(ARCHIVE_USAGE);
    return 1;
  }
  if (parsed.help) {
    out.error(ARCHIVE_USAGE);
    return 0;
  }

  const home = globalStageflowHome();
  const opened = await createRunStoreAfterHostEnsure({ rootDir: home }, () => ensureGlobalService());
  if (!opened.ok) {
    out.error(opened.message);
    return 1;
  }
  const store = opened.store;
  try {
    const result = await buildArchive({
      store,
      homeDir: home,
      ...(parsed.outPath !== undefined ? { outPath: parsed.outPath } : {}),
      includeSecrets: parsed.includeSecrets,
      includeA2aArtifacts: parsed.includeA2aArtifacts,
    });
    if (result.contains_secrets) out.error("warning: this archive contains secrets — treat the file as a secret");
    if (parsed.json) out.log(JSON.stringify(result));
    else out.log(`Wrote ${result.path} (${result.bytes} bytes, ${result.file_count} files, ${result.left_out_count} left out, sha256=${result.sha256})`);
    return 0;
  } catch (err) {
    if (err instanceof ArchiveError || err instanceof BackupError) {
      out.error(`${err.code}: ${err.message}`);
      return 1;
    }
    out.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await store.close();
  }
}
