import { writeFileSync } from "node:fs";
import {
  ArtifactQueryError,
  listArtifacts,
  parseArtifactLimit,
  readArtifact,
} from "../artifacts/query.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";
import type { ArtifactRecord } from "../artifacts/record.js";
import { readRunArtifact } from "../runread/readArtifact.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { createRunStoreAfterHostEnsure, sqliteConnectionFromStore } from "../runstore/createStore.js";
import type { RunStore } from "../runstore/port.js";
import { ensureGlobalService } from "../server/ensureGlobalService.js";
import {
  applyClientFilters,
  formatArtifactListTable,
  formatArtifactShow,
  parseArtifactShowKey,
} from "./artifactListFormat.js";
import { resolveSafeOutPath } from "./resolveSafeOutPath.js";

export const ARTIFACT_USAGE = `Usage:
  sf artifact list [--q <text>] [--kind <kind>] [--owner <pipeline:stage|agent:id>] [--live] [--project-root <wire id or path>] [--limit <n>] [--json]
  sf artifact show <key> [--project-root <wire id or path>] [--json]
  sf artifact read --run <runId> --path <relPath> [--out <file>]`;

export type ArtifactCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ArtifactCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type ParsedListArgs = {
  help: boolean;
  subcommand: "list";
  q?: string;
  kind?: string;
  owner?: string;
  live?: boolean;
  projectRoot?: string;
  limit: number;
  json: boolean;
};

type ParsedShowArgs = {
  help: boolean;
  subcommand: "show";
  key: string;
  projectRoot?: string;
  json: boolean;
};

type ParsedReadArgs = {
  help: boolean;
  subcommand: "read";
  runId?: string;
  artifactPath?: string;
  outPath?: string;
};

type ParsedArtifactArgs =
  | { help: true; json?: boolean }
  | ParsedListArgs
  | ParsedShowArgs
  | ParsedReadArgs
  | { help: false };

function parseLimitFlag(value: string): number {
  try {
    return parseArtifactLimit(value);
  } catch (err) {
    if (err instanceof ArtifactQueryError) {
      throw new Error(err.message);
    }
    throw err;
  }
}

function parseListArgs(args: string[]): ParsedListArgs {
  let q: string | undefined;
  let kind: string | undefined;
  let owner: string | undefined;
  let live: boolean | undefined;
  let projectRoot: string | undefined;
  let limit = 50;
  let json = false;
  let help = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--q") {
      const value = args[++i];
      if (value === undefined) throw new Error("Missing value for --q");
      q = value;
    } else if (arg === "--kind") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --kind");
      kind = value;
    } else if (arg === "--owner") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --owner");
      owner = value;
    } else if (arg === "--project-root") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --project-root");
      projectRoot = value;
    } else if (arg === "--limit") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --limit");
      limit = parseLimitFlag(value);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, subcommand: "list", q, kind, owner, live, projectRoot, limit, json };
}

function parseShowArgs(args: string[]): ParsedShowArgs {
  if (args.length < 2) {
    throw new Error("Missing artifact key");
  }
  const key = args[1]!;
  let projectRoot: string | undefined;
  let json = false;
  let help = false;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--project-root") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --project-root");
      projectRoot = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, subcommand: "show", key, projectRoot, json };
}

function parseReadArgs(args: string[]): ParsedReadArgs {
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
      if (value === undefined || value.length === 0) throw new Error("Missing value for --run");
      runId = value;
    } else if (arg === "--path") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --path");
      artifactPath = value;
    } else if (arg === "--out") {
      const value = args[++i];
      if (value === undefined || value.length === 0) throw new Error("Missing value for --out");
      outPath = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { help, subcommand: "read", runId, artifactPath, outPath };
}

export function parseArtifactArgs(args: string[]): ParsedArtifactArgs {
  if (args.length === 0) {
    return { help: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }

  const subcommand = args[0];
  if (subcommand === "list") return parseListArgs(args);
  if (subcommand === "show") return parseShowArgs(args);
  if (subcommand === "read") return parseReadArgs(args);
  throw new Error(`Unknown artifact subcommand: ${subcommand}`);
}

function reportQueryError(
  err: ArtifactQueryError,
  json: boolean,
  out: ArtifactCommandIo,
): number {
  const payload: Record<string, unknown> = {
    error: err.message,
    code: err.code,
  };
  if (err.projectRoots !== undefined) {
    payload.project_roots = err.projectRoots;
  }
  if (json) {
    out.log(JSON.stringify(payload));
  } else {
    let message = err.message;
    if (err.projectRoots !== undefined) {
      message += `\nProject roots: ${err.projectRoots.join(", ")}`;
    }
    out.error(message);
  }
  return 1;
}

function hasClientFilters(parsed: ParsedListArgs): boolean {
  return (
    (parsed.q !== undefined && parsed.q.trim().length > 0) ||
    (parsed.kind !== undefined && parsed.kind.trim().length > 0) ||
    (parsed.owner !== undefined && parsed.owner.trim().length > 0) ||
    parsed.live === true
  );
}

async function fetchArtifactList(
  store: RunStore,
  parsed: ParsedListArgs,
): Promise<{ artifacts: ArtifactRecord[]; next_cursor: string | null }> {
  const db = sqliteConnectionFromStore(store);
  if (db === undefined) {
    throw new ArtifactQueryError(503, "artifact.store_unavailable", "Artifact index is unavailable");
  }
  const roots = await catalogRootsForArtifacts(store);
  if (!hasClientFilters(parsed)) {
    return listArtifacts(
      db,
      {
        projectRoot: parsed.projectRoot,
        limit: parsed.limit,
      },
      roots,
    );
  }
  const filters = {
    q: parsed.q,
    kind: parsed.kind,
    owner: parsed.owner,
    live: parsed.live,
  };
  const collected: ArtifactRecord[] = [];
  let cursor: string | undefined;
  while (collected.length < parsed.limit) {
    const page = listArtifacts(
      db,
      {
        projectRoot: parsed.projectRoot,
        limit: 100,
        cursor,
      },
      roots,
    );
    const filtered = applyClientFilters(page.artifacts, filters);
    for (const record of filtered) {
      collected.push(record);
      if (collected.length >= parsed.limit) break;
    }
    if (page.next_cursor === null || collected.length >= parsed.limit) {
      break;
    }
    cursor = page.next_cursor;
  }
  return { artifacts: collected, next_cursor: null };
}

async function runListSubcommand(
  parsed: ParsedListArgs,
  store: RunStore,
  out: ArtifactCommandIo,
): Promise<number> {
  try {
    const page = await fetchArtifactList(store, parsed);
    if (parsed.json) {
      out.log(JSON.stringify(page));
    } else if (page.artifacts.length === 0) {
      out.log("No artifacts.");
    } else {
      for (const line of formatArtifactListTable(page.artifacts)) {
        out.log(line);
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof ArtifactQueryError) {
      return reportQueryError(err, parsed.json, out);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      out.log(JSON.stringify({ error: message, code: "artifact.invalid_shape" }));
    } else {
      out.error(message);
    }
    return 1;
  }
}

async function runShowSubcommand(
  parsed: ParsedShowArgs,
  store: RunStore,
  out: ArtifactCommandIo,
): Promise<number> {
  const parts = parseArtifactShowKey(parsed.key);
  if (parts === undefined) {
    const message = "Artifact key must be <ownerKey>/<id>";
    if (parsed.json) {
      out.log(JSON.stringify({ error: message, code: "artifact.invalid_id" }));
    } else {
      out.error(message);
    }
    return 1;
  }

  const db = sqliteConnectionFromStore(store);
  if (db === undefined) {
    return reportQueryError(
      new ArtifactQueryError(503, "artifact.store_unavailable", "Artifact index is unavailable"),
      parsed.json,
      out,
    );
  }

  try {
    const roots = await catalogRootsForArtifacts(store);
    const record = readArtifact(db, parts.ownerKey, parts.id, parsed.projectRoot, roots);
    if (parsed.json) {
      out.log(JSON.stringify(record));
    } else {
      out.log(formatArtifactShow(record));
    }
    return 0;
  } catch (err) {
    if (err instanceof ArtifactQueryError) {
      return reportQueryError(err, parsed.json, out);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      out.log(JSON.stringify({ error: message, code: "artifact.invalid_shape" }));
    } else {
      out.error(message);
    }
    return 1;
  }
}

async function runReadSubcommand(
  parsed: ParsedReadArgs,
  store: RunStore,
  cwd: string,
  out: ArtifactCommandIo,
): Promise<number> {
  if (!parsed.runId || !parsed.artifactPath) {
    out.error("Missing --run and/or --path");
    out.error(ARTIFACT_USAGE);
    return 1;
  }

  try {
    const contents = await readRunArtifact(store, parsed.runId, parsed.artifactPath);

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

export async function runArtifactCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<ArtifactCommandIo>;
    ensureService?: () => ReturnType<typeof ensureGlobalService>;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out: ArtifactCommandIo = { ...defaultIo, ...options.io };
  const ensureService = options.ensureService ?? (() => ensureGlobalService());

  let parsed: ParsedArtifactArgs;
  try {
    parsed = parseArtifactArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(ARTIFACT_USAGE);
    return 1;
  }

  if (parsed.help === true) {
    out.error(ARTIFACT_USAGE);
    return 0;
  }

  if (!("subcommand" in parsed)) {
    out.error("Missing artifact subcommand");
    out.error(ARTIFACT_USAGE);
    return 1;
  }

  if (parsed.help) {
    out.error(ARTIFACT_USAGE);
    return 0;
  }

  const opened = await createRunStoreAfterHostEnsure(
    { rootDir: globalStageflowHome() },
    ensureService,
  );
  if (!opened.ok) {
    const json =
      ("json" in parsed && parsed.json === true) || false;
    if (json) {
      out.log(JSON.stringify({ error: opened.message, code: "artifact.store_unavailable" }));
    } else {
      out.error(opened.message);
    }
    return 1;
  }
  const store = opened.store;

  if (parsed.subcommand === "list") {
    return runListSubcommand(parsed, store, out);
  }
  if (parsed.subcommand === "show") {
    return runShowSubcommand(parsed, store, out);
  }
  return runReadSubcommand(parsed, store, cwd, out);
}