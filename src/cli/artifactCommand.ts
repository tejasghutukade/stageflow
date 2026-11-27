import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import { artifactStorageKey, parseOwnerKey } from "../artifacts/keys.js";
import { ArtifactPublishError } from "../artifacts/limits.js";
import { isLiveKind } from "../artifacts/kinds.js";
import { approveOrigins, revokeOrigins } from "../artifacts/originApproval.js";
import { isInsideStageflowSession } from "../artifacts/sessionEnv.js";
import { deletePublishedArtifact, publishArtifact } from "../artifacts/publish.js";
import { promoteSessionArtifact } from "../artifacts/sessionScope.js";
import { queryBinding } from "../artifacts/bindingQuery.js";
import { refreshArtifact } from "../artifacts/refresh.js";
import {
  ArtifactQueryError,
  listArtifacts,
  parseArtifactKindFilter,
  parseArtifactLimit,
  parseArtifactListOrder,
  parseArtifactListSort,
  parseArtifactOwnerFilter,
  parseArtifactScope,
  parseArtifactStatus,
  parseArtifactTagFilter,
  readArtifact,
  type ArtifactListQuery,
} from "../artifacts/query.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";
import { artifactOwnerKey, type ArtifactOwner, type ArtifactRecord } from "../artifacts/record.js";
import { readRunArtifact } from "../runread/readArtifact.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { createRunStoreAfterHostEnsure, sqliteConnectionFromStore } from "../runstore/createStore.js";
import type { RunStore } from "../runstore/port.js";
import { ensureGlobalService } from "../server/ensureGlobalService.js";
import {
  formatArtifactListTable,
  formatArtifactQuery,
  formatArtifactRefresh,
  formatArtifactShow,
  parseArtifactShowKey,
} from "./artifactListFormat.js";
import { resolveSafeOutPath } from "./resolveSafeOutPath.js";

export const ARTIFACT_USAGE = `Usage:
  sf artifact list [--q <text>] [--kind <kind>] [--owner <pipeline:stage|agent:id>] [--tag <tag>] [--status <available|expired>] [--live] [--scope <project|session>] [--sort <updated|title|size>] [--order <asc|desc>] [--project-root <wire id or path>] [--limit <n>] [--json]
  sf artifact show <key> [--project-root <wire id or path>] [--json]
  sf artifact promote <key> [--project-root <wire id or path>] [--json]
  sf artifact refresh <key> [--binding <id>]... [--if-stale] [--project-root <wire id or path>] [--json]
  sf artifact query <key> --binding <id> [--args <json>] [--if-stale|--no-if-stale] [--project-root <wire id or path>] [--json]
  sf artifact publish --owner <pipeline:stage|agent:id> --id <id> --kind <kind> --title <title> [--description <text>] [--tag <tag>]... [--summary <text>] [--manifest <file>] [--project-root <wire id or path>] (--file <path> | --stdin) [--json]
  sf artifact delete <key> [--project-root <wire id or path>] [--yes] [--json]
  sf artifact origins <key> [--project-root <wire id or path>] [--json]
  sf artifact approve-origins <key> [--hash <h>] [--yes] [--project-root <wire id or path>] [--json]
  sf artifact revoke-origins <key> [--hash <h>] [--project-root <wire id or path>] [--json]
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
  tag?: string;
  status?: string;
  live?: boolean;
  scope?: string;
  sort?: string;
  order?: string;
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

type ParsedPromoteArgs = Omit<ParsedShowArgs, "subcommand"> & { subcommand: "promote" };

type ParsedReadArgs = {
  help: boolean;
  subcommand: "read";
  runId?: string;
  artifactPath?: string;
  outPath?: string;
};

type ParsedPublishArgs = {
  help: boolean;
  subcommand: "publish";
  owner?: string;
  id?: string;
  kind?: string;
  title?: string;
  description?: string;
  tags: string[];
  summary?: string;
  projectRoot?: string;
  file?: string;
  manifest?: string;
  stdin: boolean;
  json: boolean;
};

type ParsedRefreshArgs = {
  help: boolean;
  subcommand: "refresh";
  key: string;
  bindings: string[];
  ifStale: boolean;
  projectRoot?: string;
  json: boolean;
};

type ParsedQueryArgs = {
  help: boolean;
  subcommand: "query";
  key: string;
  binding?: string;
  args?: string;
  ifStale: boolean;
  projectRoot?: string;
  json: boolean;
};

type ParsedOriginsArgs = {
  help: boolean;
  subcommand: "origins" | "approve-origins" | "revoke-origins";
  key: string;
  projectRoot?: string;
  hash?: string;
  yes: boolean;
  json: boolean;
};

type ParsedDeleteArgs = {
  help: boolean;
  subcommand: "delete";
  key: string;
  projectRoot?: string;
  yes: boolean;
  json: boolean;
};

type ParsedArtifactArgs =
  | { help: true; json?: boolean }
  | ParsedListArgs
  | ParsedShowArgs
  | ParsedPromoteArgs
  | ParsedReadArgs
  | ParsedPublishArgs
  | ParsedRefreshArgs
  | ParsedQueryArgs
  | ParsedDeleteArgs
  | ParsedOriginsArgs
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

function requireListValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseListArgs(args: string[]): ParsedListArgs {
  let q: string | undefined;
  let kind: string | undefined;
  let owner: string | undefined;
  let tag: string | undefined;
  let status: string | undefined;
  let live: boolean | undefined;
  let scope: string | undefined;
  let sort: string | undefined;
  let order: string | undefined;
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
    } else if (arg === "--scope") {
      scope = requireListValue(args, ++i, "--scope");
    } else if (arg === "--q") {
      const value = args[++i];
      if (value === undefined) throw new Error("Missing value for --q");
      q = value;
    } else if (arg === "--kind") {
      kind = requireListValue(args, ++i, "--kind");
    } else if (arg === "--owner") {
      owner = requireListValue(args, ++i, "--owner");
    } else if (arg === "--tag") {
      tag = requireListValue(args, ++i, "--tag");
    } else if (arg === "--status") {
      status = requireListValue(args, ++i, "--status");
    } else if (arg === "--sort") {
      sort = requireListValue(args, ++i, "--sort");
    } else if (arg === "--order") {
      order = requireListValue(args, ++i, "--order");
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

  return { help, subcommand: "list", q, kind, owner, tag, status, live, scope, sort, order, projectRoot, limit, json };
}

function ownerListFilter(owner: string): string {
  const trimmed = owner.trim();
  if (trimmed.startsWith("stage:") || trimmed.startsWith("agent:")) return trimmed;
  const colon = trimmed.indexOf(":");
  if (colon > 0 && trimmed.indexOf(":", colon + 1) === -1) return `stage:${trimmed}`;
  return trimmed;
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

function requireFlag(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parsePublishOwner(raw: string): ArtifactOwner {
  if (raw.startsWith("eval:")) throw new Error("owner must not use the eval namespace");
  if (raw.startsWith("agent:")) {
    const agent = raw.slice("agent:".length);
    if (agent.length === 0) throw new Error("Owner must be <pipeline>:<stage> or agent:<id>");
    return { kind: "agent", agent };
  }
  if (raw.startsWith("stage:")) {
    const parsed = parseOwnerKey(raw);
    if (parsed?.kind !== "stage") throw new Error("Owner must be <pipeline>:<stage> or agent:<id>");
    return parsed;
  }
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) {
    throw new Error("Owner must be <pipeline>:<stage> or agent:<id>");
  }
  return { kind: "stage", pipeline: raw.slice(0, colon), stage: raw.slice(colon + 1) };
}

function parsePublishArgs(args: string[]): ParsedPublishArgs {
  let owner: string | undefined;
  let id: string | undefined;
  let kind: string | undefined;
  let title: string | undefined;
  let description: string | undefined;
  const tags: string[] = [];
  let summary: string | undefined;
  let projectRoot: string | undefined;
  let file: string | undefined;
  let manifest: string | undefined;
  let stdin = false;
  let json = false;
  let help = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--stdin") stdin = true;
    else if (arg === "--owner") owner = requireFlag(args[++i], "--owner");
    else if (arg === "--id") id = requireFlag(args[++i], "--id");
    else if (arg === "--kind") kind = requireFlag(args[++i], "--kind");
    else if (arg === "--title") title = requireFlag(args[++i], "--title");
    else if (arg === "--description") description = requireFlag(args[++i], "--description");
    else if (arg === "--tag") tags.push(requireFlag(args[++i], "--tag"));
    else if (arg === "--summary") summary = requireFlag(args[++i], "--summary");
    else if (arg === "--project-root") projectRoot = requireFlag(args[++i], "--project-root");
    else if (arg === "--file") file = requireFlag(args[++i], "--file");
    else if (arg === "--manifest") manifest = requireFlag(args[++i], "--manifest");
    else if (arg?.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!help) {
    requireFlag(owner, "--owner");
    requireFlag(id, "--id");
    requireFlag(kind, "--kind");
    requireFlag(title, "--title");
    if (Boolean(file) === stdin) throw new Error("Pass exactly one of --file or --stdin");
  }
  return { help, subcommand: "publish", owner, id, kind, title, description, tags, summary, projectRoot, file, manifest, stdin, json };
}

function parseRefreshArgs(args: string[]): ParsedRefreshArgs {
  if (args.length < 2) throw new Error("Missing artifact key");
  const key = args[1]!;
  const bindings: string[] = [];
  let projectRoot: string | undefined;
  let json = false;
  let help = false;
  let ifStale = false;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--if-stale") ifStale = true;
    else if (arg === "--binding") bindings.push(requireFlag(args[++i], "--binding"));
    else if (arg === "--project-root") projectRoot = requireFlag(args[++i], "--project-root");
    else if (arg?.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { help, subcommand: "refresh", key, bindings, ifStale, projectRoot, json };
}

function parseQueryArgs(args: string[]): ParsedQueryArgs {
  if (args.length < 2) throw new Error("Missing artifact key");
  const key = args[1]!;
  let binding: string | undefined;
  let argsJson: string | undefined;
  let projectRoot: string | undefined;
  let json = false;
  let help = false;
  let staleFlag: boolean | undefined;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--if-stale") {
      if (staleFlag === false) throw new Error("Pass only one of --if-stale or --no-if-stale");
      staleFlag = true;
    } else if (arg === "--no-if-stale") {
      if (staleFlag === true) throw new Error("Pass only one of --if-stale or --no-if-stale");
      staleFlag = false;
    } else if (arg === "--binding") binding = requireFlag(args[++i], "--binding");
    else if (arg === "--args") argsJson = requireFlag(args[++i], "--args");
    else if (arg === "--project-root") projectRoot = requireFlag(args[++i], "--project-root");
    else if (arg?.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!help && (binding === undefined || binding.length === 0)) throw new Error("Missing value for --binding");
  return { help, subcommand: "query", key, binding, args: argsJson, ifStale: staleFlag !== false, projectRoot, json };
}

function parseDeleteArgs(args: string[]): ParsedDeleteArgs {
  if (args.length < 2) throw new Error("Missing artifact key");
  const key = args[1]!;
  let projectRoot: string | undefined;
  let yes = false;
  let json = false;
  let help = false;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--project-root") projectRoot = requireFlag(args[++i], "--project-root");
    else if (arg?.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { help, subcommand: "delete", key, projectRoot, yes, json };
}

function parseOriginsArgs(args: string[], subcommand: ParsedOriginsArgs["subcommand"]): ParsedOriginsArgs {
  if (args.length < 2) throw new Error("Missing artifact key");
  const key = args[1]!;
  let projectRoot: string | undefined;
  let hash: string | undefined;
  let yes = false;
  let json = false;
  let help = false;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--hash") hash = requireFlag(args[++i], "--hash");
    else if (arg === "--project-root") projectRoot = requireFlag(args[++i], "--project-root");
    else if (arg?.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { help, subcommand, key, projectRoot, hash, yes, json };
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
  if (subcommand === "promote") {
    const shown = parseShowArgs(args);
    const promoted: ParsedPromoteArgs = { ...shown, subcommand: "promote" };
    return promoted;
  }
  if (subcommand === "read") return parseReadArgs(args);
  if (subcommand === "publish") return parsePublishArgs(args);
  if (subcommand === "refresh") return parseRefreshArgs(args);
  if (subcommand === "query") return parseQueryArgs(args);
  if (subcommand === "delete") return parseDeleteArgs(args);
  if (subcommand === "origins" || subcommand === "approve-origins" || subcommand === "revoke-origins") {
    return parseOriginsArgs(args, subcommand);
  }
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

function serverListQuery(parsed: ParsedListArgs): Omit<ArtifactListQuery, "limit" | "cursor"> {
  return {
    projectRoot: parsed.projectRoot,
    kind: parsed.kind !== undefined ? parseArtifactKindFilter(parsed.kind) : undefined,
    owner: parsed.owner !== undefined ? parseArtifactOwnerFilter(ownerListFilter(parsed.owner)) : undefined,
    tag: parsed.tag !== undefined ? parseArtifactTagFilter(parsed.tag) : undefined,
    status: parsed.status !== undefined ? parseArtifactStatus(parsed.status) : undefined,
    live: parsed.live === true ? true : undefined,
    scope: parsed.scope !== undefined ? parseArtifactScope(parsed.scope) : undefined,
    sort: parsed.sort !== undefined ? parseArtifactListSort(parsed.sort) : undefined,
    order: parsed.order !== undefined ? parseArtifactListOrder(parsed.order) : undefined,
    q: parsed.q?.trim() ? parsed.q.trim() : undefined,
  };
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
  return listArtifacts(db, { ...serverListQuery(parsed), limit: parsed.limit }, roots);
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

async function runPromoteSubcommand(
  parsed: ParsedPromoteArgs,
  store: RunStore,
  out: ArtifactCommandIo,
): Promise<number> {
  const parts = parseArtifactShowKey(parsed.key);
  if (parts === undefined) {
    const message = "Artifact key must be <ownerKey>/<id>";
    if (parsed.json) out.log(JSON.stringify({ error: message, code: "artifact.invalid_id" }));
    else out.error(message);
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
    const ownerKey = artifactOwnerKey(record.owner);
    promoteSessionArtifact(db, artifactStorageKey(record.project.id, ownerKey, record.id));
    const kept = readArtifact(db, parts.ownerKey, parts.id, parsed.projectRoot, roots);
    if (parsed.json) out.log(JSON.stringify(kept));
    else out.log(formatArtifactShow(kept));
    return 0;
  } catch (err) {
    if (err instanceof ArtifactQueryError) return reportQueryError(err, parsed.json, out);
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) out.log(JSON.stringify({ error: message, code: "artifact.invalid_shape" }));
    else out.error(message);
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

function reportPublishError(err: ArtifactPublishError, json: boolean, out: ArtifactCommandIo): number {
  const payload: Record<string, unknown> = { error: err.message, code: err.code };
  if (err.issues !== undefined) payload.issues = err.issues;
  if (err.projectRoots !== undefined) payload.project_roots = err.projectRoots;
  if (err.details !== undefined) Object.assign(payload, err.details);
  if (json) out.log(JSON.stringify(payload));
  else out.error(err.message);
  return 1;
}

function reportCommandError(message: string, code: string, json: boolean, out: ArtifactCommandIo): number {
  if (json) out.log(JSON.stringify({ error: message, code }));
  else out.error(message);
  return 1;
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function promptYes(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function runPublishSubcommand(
  parsed: ParsedPublishArgs,
  store: RunStore,
  cwd: string,
  out: ArtifactCommandIo,
  readStdin: () => Promise<Buffer>,
): Promise<number> {
  const db = sqliteConnectionFromStore(store);
  if (db === undefined) {
    return reportQueryError(
      new ArtifactQueryError(503, "artifact.store_unavailable", "Artifact index is unavailable"),
      parsed.json,
      out,
    );
  }
  try {
    const bytes = parsed.file ? await readFile(path.resolve(cwd, parsed.file)) : await readStdin();
    let manifest: unknown;
    if (parsed.manifest) {
      const raw = await readFile(path.resolve(cwd, parsed.manifest), "utf8");
      try {
        manifest = JSON.parse(raw) as unknown;
      } catch {
        return reportCommandError("manifest is not JSON", "artifact.invalid_shape", parsed.json, out);
      }
    }
    const result = await publishArtifact(db, {
      owner: parsePublishOwner(parsed.owner ?? ""),
      projectRoot: parsed.projectRoot,
      id: parsed.id ?? "",
      kind: parsed.kind ?? "",
      title: parsed.title ?? "",
      description: parsed.description,
      tags: parsed.tags,
      summary: parsed.summary,
      bytes,
      ...(manifest !== undefined ? { manifest } : {}),
      publishSource: "console",
      roots: await catalogRootsForArtifacts(store),
    });
    if (parsed.json) out.log(JSON.stringify(result));
    else out.log(`${result.unchanged ? "Unchanged" : "Published"} ${result.key} version ${result.version}`);
    return 0;
  } catch (error) {
    if (error instanceof ArtifactPublishError) return reportPublishError(error, parsed.json, out);
    if (error instanceof ArtifactQueryError) return reportQueryError(error, parsed.json, out);
    const message = error instanceof Error ? error.message : String(error);
    return reportCommandError(message, "artifact.invalid_shape", parsed.json, out);
  }
}

function storageKeyFor(record: ArtifactRecord): string {
  return artifactStorageKey(record.project.id, artifactOwnerKey(record.owner), record.id);
}

async function runRefreshSubcommand(
  parsed: ParsedRefreshArgs,
  store: RunStore,
  out: ArtifactCommandIo,
): Promise<number> {
  const parts = parseArtifactShowKey(parsed.key);
  if (!parts) return reportCommandError("Artifact key is not valid", "artifact.invalid_id", parsed.json, out);
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
    if (!isLiveKind(record.kind)) {
      return reportQueryError(new ArtifactQueryError(404, "artifact.not_live", "Artifact is not live"), parsed.json, out);
    }
    const root = roots.find((item) => item.project_root === record.project.id);
    const result = await refreshArtifact(
      db,
      { projectRoot: root?.path ?? record.project.id, projectId: record.project.id },
      storageKeyFor(record),
      {
        ...(parsed.bindings.length > 0 ? { bindingIds: parsed.bindings } : {}),
        ...(parsed.ifStale ? { ifStale: true } : {}),
      },
    );
    if (parsed.json) out.log(JSON.stringify(result));
    else out.log(formatArtifactRefresh(result));
    return result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof ArtifactPublishError) return reportPublishError(error, parsed.json, out);
    if (error instanceof ArtifactQueryError) return reportQueryError(error, parsed.json, out);
    const message = error instanceof Error ? error.message : String(error);
    return reportCommandError(message, "artifact.invalid_shape", parsed.json, out);
  }
}

function parseQueryArgsJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "--args must be a JSON object", [
      { path: "args", message: "must be a JSON object" },
    ]);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArtifactPublishError(400, "artifact.binding_args_invalid", "Binding arguments are not valid", [
      { path: "args", message: "must be an object" },
    ]);
  }
  return parsed as Record<string, unknown>;
}

async function runQuerySubcommand(
  parsed: ParsedQueryArgs,
  store: RunStore,
  out: ArtifactCommandIo,
): Promise<number> {
  const parts = parseArtifactShowKey(parsed.key);
  if (!parts) return reportCommandError("Artifact key is not valid", "artifact.invalid_id", parsed.json, out);
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
    const root = roots.find((item) => item.project_root === record.project.id);
    const args = parseQueryArgsJson(parsed.args);
    const result = await queryBinding(
      db,
      { projectRoot: root?.path ?? record.project.id, projectId: record.project.id },
      storageKeyFor(record),
      {
        bindingId: parsed.binding ?? "",
        ...(args !== undefined ? { args } : {}),
        ifStale: parsed.ifStale,
      },
    );
    if (parsed.json) out.log(JSON.stringify(result));
    else out.log(formatArtifactQuery(result));
    return result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof ArtifactPublishError) return reportPublishError(error, parsed.json, out);
    if (error instanceof ArtifactQueryError) return reportQueryError(error, parsed.json, out);
    const message = error instanceof Error ? error.message : String(error);
    return reportCommandError(message, "artifact.invalid_shape", parsed.json, out);
  }
}

async function runDeleteSubcommand(
  parsed: ParsedDeleteArgs,
  store: RunStore,
  out: ArtifactCommandIo,
  options: { stdinIsTTY?: boolean; confirm?: (prompt: string) => Promise<boolean> },
): Promise<number> {
  const parts = parseArtifactShowKey(parsed.key);
  if (!parts) return reportCommandError("Artifact key is not valid", "artifact.invalid_id", parsed.json, out);
  if (!parsed.yes) {
    const prompt = `Delete published artifact ${parsed.key} and all of its versions? This cannot be undone. [y/N] `;
    let confirmed = false;
    if (options.confirm) confirmed = await options.confirm(prompt);
    else if (options.stdinIsTTY === true) confirmed = await promptYes(prompt);
    else {
      return reportCommandError(
        "Refusing to delete without --yes because stdin is not a terminal.",
        "artifact.confirmation_required",
        parsed.json,
        out,
      );
    }
    if (!confirmed) {
      return reportCommandError("Delete cancelled.", "artifact.confirmation_required", parsed.json, out);
    }
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
    const deleted = await deletePublishedArtifact(db, parts.ownerKey, parts.id, parsed.projectRoot, roots);
    if (parsed.json) out.log(JSON.stringify(deleted));
    else out.log(`Deleted ${deleted.key}`);
    return 0;
  } catch (error) {
    if (error instanceof ArtifactPublishError) return reportPublishError(error, parsed.json, out);
    if (error instanceof ArtifactQueryError) return reportQueryError(error, parsed.json, out);
    const message = error instanceof Error ? error.message : String(error);
    return reportCommandError(message, "artifact.invalid_shape", parsed.json, out);
  }
}

function originLines(record: ArtifactRecord): string[] {
  const origins = record.live?.origins;
  if (!origins) return ["No declared origins."];
  const lines = (label: string, values: string[]): string[] => [label, ...(values.length > 0 ? values.map((value) => `  ${value}`) : ["  (none)"])];
  return [
    ...lines("Send and receive data (connect)", origins.connect),
    ...lines("Load scripts, styles, images and fonts (resources)", origins.resource),
    ...lines("Base URL", origins.base),
    `hash: ${origins.hash}`,
    `approved: ${origins.approved ? "yes" : "no"}`,
    ...(origins.approved_at ? [`approved_at: ${origins.approved_at}`] : []),
  ];
}

async function runOriginsSubcommand(
  parsed: ParsedOriginsArgs,
  store: RunStore,
  out: ArtifactCommandIo,
  options: { stdinIsTTY?: boolean; confirm?: (prompt: string) => Promise<boolean> },
): Promise<number> {
  if (
    (parsed.subcommand === "approve-origins" || parsed.subcommand === "revoke-origins") &&
    isInsideStageflowSession(process.env)
  ) {
    return reportCommandError(
      "approval is an operator action: refused inside a stage or agent session",
      "artifact.operator_only",
      parsed.json,
      out,
    );
  }
  const parts = parseArtifactShowKey(parsed.key);
  if (!parts) return reportCommandError("Artifact key is not valid", "artifact.invalid_id", parsed.json, out);
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
    const origins = record.live?.origins;
    if (!origins || record.kind !== "live.html") {
      return reportCommandError("no origins to approve", "artifact.invalid_shape", parsed.json, out);
    }
    const owner = artifactOwnerKey(record.owner);
    const storageKey = artifactStorageKey(record.project.id, owner, record.id);
    if (parsed.subcommand === "origins") {
      if (parsed.json) out.log(JSON.stringify({ key: record.key, origins }));
      else out.log(originLines(record).join("\n"));
      return 0;
    }
    if (parsed.subcommand === "approve-origins" && parsed.hash !== undefined && parsed.hash !== origins.hash) {
      return reportPublishError(
        new ArtifactPublishError(
          409,
          "artifact.origins_mismatch",
          "origins hash does not match the current manifest",
          [{ path: "origins_hash", message: "origins hash does not match the current manifest" }],
          undefined,
          { current_hash: origins.hash },
        ),
        parsed.json,
        out,
      );
    }
    if (parsed.subcommand === "approve-origins") {
      if (!parsed.yes) {
        out.error(originLines(record).join("\n"));
        const prompt = `Approve these origins for ${record.key}? An approved connect origin can receive any data the artifact can read. [y/N] `;
        let confirmed = false;
        if (options.confirm) confirmed = await options.confirm(prompt);
        else if (options.stdinIsTTY === true) confirmed = await promptYes(prompt);
        else {
          return reportCommandError(
            "Refusing to approve origins without --yes because stdin is not a terminal.",
            "artifact.confirmation_required",
            parsed.json,
            out,
          );
        }
        if (!confirmed) {
          return reportCommandError("Approval cancelled.", "artifact.confirmation_required", parsed.json, out);
        }
      }
      const approved = approveOrigins(db, storageKey, { originsHash: parsed.hash ?? origins.hash, by: "cli" });
      if (parsed.json) out.log(JSON.stringify(approved));
      else out.log(`Approved ${approved.origins.hash}`);
      return 0;
    }
    const revoked = revokeOrigins(db, storageKey, parsed.hash);
    if (parsed.json) out.log(JSON.stringify(revoked));
    else out.log(`Revoked ${revoked.revoked} origin approval${revoked.revoked === 1 ? "" : "s"}`);
    return 0;
  } catch (error) {
    if (error instanceof ArtifactPublishError) return reportPublishError(error, parsed.json, out);
    if (error instanceof ArtifactQueryError) return reportQueryError(error, parsed.json, out);
    const message = error instanceof Error ? error.message : String(error);
    return reportCommandError(message, "artifact.invalid_shape", parsed.json, out);
  }
}

export async function runArtifactCommand(
  args: string[],
  options: {
    cwd?: string;
    projectRoot?: string;
    io?: Partial<ArtifactCommandIo>;
    ensureService?: () => ReturnType<typeof ensureGlobalService>;
    readStdin?: () => Promise<Buffer>;
    stdinIsTTY?: boolean;
    confirm?: (prompt: string) => Promise<boolean>;
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
  if (parsed.subcommand === "promote") {
    return runPromoteSubcommand(parsed, store, out);
  }
  if (parsed.subcommand === "publish") {
    return runPublishSubcommand(parsed, store, cwd, out, options.readStdin ?? readStdinBytes);
  }
  if (parsed.subcommand === "refresh") {
    return runRefreshSubcommand(parsed, store, out);
  }
  if (parsed.subcommand === "query") {
    return runQuerySubcommand(parsed, store, out);
  }
  if (parsed.subcommand === "delete") {
    return runDeleteSubcommand(parsed, store, out, options);
  }
  if (parsed.subcommand === "origins" || parsed.subcommand === "approve-origins" || parsed.subcommand === "revoke-origins") {
    return runOriginsSubcommand(parsed, store, out, options);
  }
  if (parsed.subcommand === "read") {
    return runReadSubcommand(parsed, store, cwd, out);
  }
  return 1;
}