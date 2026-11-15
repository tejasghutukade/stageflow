import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../package-meta.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { assertBackupOutPathAllowed, backupsDir, verifyDbSnapshot } from "../runstore/backup.js";
import { readFilesystemSize } from "../runstore/diskUsage.js";
import type { RunStore } from "../runstore/port.js";
import { ARCHIVE_RULES, isDeniedRunPath, ruleFor, ruleMentions, type ArchiveRule } from "./inventory.js";
import { TarStream } from "./tarStream.js";

export const ARCHIVE_VERSION = 1;

export type ArchiveErrorCode = "archive_insufficient_space" | "archive_out_denied" | "archive_verify_failed";

export class ArchiveError extends Error {
  constructor(message: string, readonly code: ArchiveErrorCode, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "ArchiveError";
  }
}

export type ArchiveFileEntry = { path: string; kind: "file" | "symlink" | "directory"; size: number; sha256?: string; link?: string };
export type ArchiveLeftOut = { path: string; reason: string };

export type ArchiveManifest = {
  archive_version: number;
  stageflow_version: string;
  created_at: string;
  contains_secrets: boolean;
  home_id: string | null;
  store_schema_version: number;
  files: ArchiveFileEntry[];
  left_out: ArchiveLeftOut[];
};

export type ArchiveResult = {
  path: string;
  bytes: number;
  sha256: string;
  created_at: string;
  archive_version: number;
  stageflow_version: string;
  contains_secrets: boolean;
  file_count: number;
  left_out_count: number;
};

export type BuildArchiveOptions = {
  store: Pick<RunStore, "snapshotInto" | "listRuns" | "getWorkspaceDir">;
  homeDir?: string;
  outPath?: string;
  includeSecrets?: boolean;
  includeA2aArtifacts?: boolean;
  freeSpace?: (rootPath: string) => Promise<{ freeBytes: number }>;
  now?: () => Date;
};

type PlannedEntry =
  | { name: string; kind: "file"; source: string; size: number; mode: number; mtime: number }
  | { name: string; kind: "symlink"; target: string; mode: number; mtime: number }
  | { name: string; kind: "directory"; mode: number; mtime: number }
  | { name: string; kind: "database"; source: string };

const FREE_SPACE_MARGIN_BYTES = 8 * 1024 * 1024;

export function defaultArchiveOutPath(homeDir: string, now: Date): string {
  return path.join(backupsDir(homeDir), `stageflow-archive-${now.toISOString().replace(/[:.]/g, "-")}.tar.gz`);
}

const posix = (p: string): string => p.split(path.sep).join("/");
const SIDECAR = /\.db-(wal|shm)$/;
const LEFTOVER = /(\.pre-restore-|\.partial$)/;

function readHomeId(homeDir: string): string | null {
  try {
    const value = readFileSync(path.join(homeDir, "host-id"), "utf8").trim();
    return /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function describe(rule: ArchiveRule, options: { includeSecrets: boolean; includeA2a: boolean }): "include" | { reason: string } {
  if (rule.kind === "never") return { reason: rule.reason };
  if (rule.optIn === "a2a-artifacts" && !options.includeA2a) return { reason: "A2A artifacts are included only on request" };
  if (rule.kind === "secret" && !options.includeSecrets) return { reason: `${rule.reason}; secrets are included only on request` };
  return "include";
}

/** Walks the data directory under the inventory rules and returns what to copy and what is left out, with a reason. */
export function planArchive(homeDir: string, options: { includeSecrets: boolean; includeA2a: boolean }): { entries: PlannedEntry[]; leftOut: ArchiveLeftOut[] } {
  const entries: PlannedEntry[] = [];
  const leftOut: ArchiveLeftOut[] = [];
  const groups = new Map<string, { rule: ArchiveRule; relative: string }[]>();

  const visit = (relative: string, absolute: string, depth: number): void => {
    if (relative === "runs" || relative.startsWith("runs/")) return;
    const stat = lstatSync(absolute);
    if (SIDECAR.test(relative) || LEFTOVER.test(relative)) return;
    const rule = ruleFor(stat.isDirectory() ? `${relative}/` : relative) ?? ruleFor(relative);
    if (rule === undefined) {
      if (stat.isDirectory() && ruleMentions(relative)) {
        for (const child of readdirSync(absolute).sort()) visit(`${relative}/${child}`, path.join(absolute, child), depth + 1);
        return;
      }
      leftOut.push({ path: stat.isDirectory() ? `${relative}/` : relative, reason: "not in the archive inventory" });
      return;
    }
    if (rule.group !== undefined) {
      const list = groups.get(rule.group) ?? [];
      list.push({ rule, relative });
      groups.set(rule.group, list);
    }
    const decision = describe(rule, options);
    if (decision !== "include") {
      leftOut.push({ path: stat.isDirectory() ? `${relative}/` : relative, reason: decision.reason });
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ name: relative, kind: "symlink", target: readlinkSync(absolute), mode: stat.mode, mtime: stat.mtimeMs / 1000 });
    } else if (stat.isDirectory()) {
      const children = readdirSync(absolute).sort();
      if (children.length === 0) entries.push({ name: relative, kind: "directory", mode: stat.mode, mtime: stat.mtimeMs / 1000 });
      for (const child of children) visit(`${relative}/${child}`, path.join(absolute, child), depth + 1);
    } else if (stat.isFile()) {
      if (rule.kind === "database") entries.push({ name: relative, kind: "database", source: absolute });
      else entries.push({ name: relative, kind: "file", source: absolute, size: stat.size, mode: stat.mode, mtime: stat.mtimeMs / 1000 });
    }
  };

  for (const child of readdirSync(homeDir).sort()) visit(child, path.join(homeDir, child), 1);

  // Files of one group (the MCP sign-in store and its key) go in together or not at all.
  const pairedGroups = new Set(ARCHIVE_RULES.filter((rule) => rule.group).map((rule) => rule.group!));
  for (const group of pairedGroups) {
    const rules = ARCHIVE_RULES.filter((rule) => rule.group === group);
    const onDisk = rules.filter((rule) => existsSync(path.join(homeDir, rule.path)));
    if (onDisk.length === rules.length) continue;
    for (const rule of onDisk) {
      const index = entries.findIndex((entry) => entry.name === rule.path);
      if (index >= 0) {
        entries.splice(index, 1);
        const existing = leftOut.findIndex((item) => item.path === rule.path);
        if (existing < 0) leftOut.push({ path: rule.path, reason: "left out because its pair is missing" });
      }
    }
  }
  return { entries, leftOut };
}

async function planRuns(store: BuildArchiveOptions["store"], homeDir: string, entries: PlannedEntry[], leftOut: ArchiveLeftOut[]): Promise<void> {
  for (const run of await store.listRuns()) {
    const workspace = store.getWorkspaceDir(run.run_id);
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) continue;
    const base = posix(path.relative(homeDir, workspace));
    if (base.startsWith("..") || path.isAbsolute(base)) continue;
    const walk = (relative: string, absolute: string): void => {
      const stat = lstatSync(absolute);
      const name = `${base}/${relative}`;
      if (isDeniedRunPath(relative)) {
        leftOut.push({ path: stat.isDirectory() ? `${name}/` : name, reason: "agent files, credentials and dependency or checkout folders are never copied from a run" });
        return;
      }
      if (stat.isSymbolicLink()) entries.push({ name, kind: "symlink", target: readlinkSync(absolute), mode: stat.mode, mtime: stat.mtimeMs / 1000 });
      else if (stat.isDirectory()) {
        const children = readdirSync(absolute).sort();
        if (children.length === 0) entries.push({ name, kind: "directory", mode: stat.mode, mtime: stat.mtimeMs / 1000 });
        for (const child of children) walk(`${relative}/${child}`, path.join(absolute, child));
      } else if (stat.isFile()) entries.push({ name, kind: "file", source: absolute, size: stat.size, mode: stat.mode, mtime: stat.mtimeMs / 1000 });
    };
    for (const child of readdirSync(workspace).sort()) walk(child, path.join(workspace, child));
  }
}

function vacuumInto(source: string, dest: string): number {
  const db = new Database(source, { fileMustExist: true });
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    return db.pragma("user_version", { simple: true }) as number;
  } finally {
    db.close();
  }
}

/**
 * Builds one tar.gz of everything the owner would want to keep (see inventory.ts), with a manifest as the last member.
 * Streams to disk, so memory stays flat; secrets are left out unless asked for.
 */
export async function buildArchive(options: BuildArchiveOptions): Promise<ArchiveResult> {
  const homeDir = options.homeDir ?? globalStageflowHome();
  const includeSecrets = options.includeSecrets === true;
  const includeA2a = options.includeA2aArtifacts === true;
  const now = options.now?.() ?? new Date();
  const createdAt = now.toISOString();

  const outPath = (() => {
    try {
      return assertBackupOutPathAllowed(options.outPath ?? defaultArchiveOutPath(homeDir, now), homeDir);
    } catch (error) {
      throw new ArchiveError(String((error as Error).message).replace("backup_out_denied", "archive_out_denied"), "archive_out_denied");
    }
  })();
  if (isUnder(outPath, path.join(homeDir, "runs")) || isUnder(outPath, path.join(homeDir, "worktrees"))) {
    throw new ArchiveError("archive_out_denied: refusing to write under runs/ or worktrees/", "archive_out_denied");
  }
  mkdirSync(path.dirname(outPath), { recursive: true });

  const { entries, leftOut } = planArchive(homeDir, { includeSecrets, includeA2a });
  await planRuns(options.store, homeDir, entries, leftOut);

  const estimate = entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : entry.kind === "database" ? statSync(entry.source).size : 0), 0);
  const free = await (options.freeSpace ?? readFilesystemSize)(path.dirname(outPath));
  const needed = estimate + FREE_SPACE_MARGIN_BYTES;
  if (free.freeBytes < needed) {
    throw new ArchiveError(`archive_insufficient_space: need up to ${needed} bytes free, have ${free.freeBytes}`, "archive_insufficient_space", { needed_bytes: needed, free_bytes: free.freeBytes });
  }

  const staging = await mkdtemp(path.join(tmpdir(), "sf-archive-"));
  const partial = `${outPath}.partial`;
  try {
    rmSync(partial, { force: true });
    const gzip = createGzip();
    const out = createWriteStream(partial, { mode: 0o600 });
    const writing = pipeline(gzip, out);
    const tar = new TarStream(gzip);
    const files: ArchiveFileEntry[] = [];
    let schemaVersion = 0;

    for (const entry of entries) {
      if (entry.kind === "database") {
        const dest = path.join(staging, `${files.length}.db`);
        let version: number;
        if (entry.name === "state.db") {
          version = (await options.store.snapshotInto(dest)).userVersion;
          verifyDbSnapshot(dest, version);
          schemaVersion = version;
        } else {
          version = vacuumInto(entry.source, dest);
        }
        const size = statSync(dest).size;
        const result = await tar.addFile(entry.name, dest, size, { mode: 0o600, mtimeSeconds: now.getTime() / 1000 });
        files.push({ path: entry.name, kind: "file", size: result.size, sha256: result.sha256 });
        rmSync(dest, { force: true });
      } else if (entry.kind === "file") {
        const result = await tar.addFile(entry.name, entry.source, entry.size, { mode: entry.mode, mtimeSeconds: entry.mtime });
        files.push({ path: entry.name, kind: "file", size: result.size, sha256: result.sha256 });
      } else if (entry.kind === "symlink") {
        await tar.addSymlink(entry.name, entry.target, { mode: entry.mode, mtimeSeconds: entry.mtime });
        files.push({ path: entry.name, kind: "symlink", size: 0, link: entry.target });
      } else {
        await tar.addDirectory(entry.name, { mode: entry.mode, mtimeSeconds: entry.mtime });
        files.push({ path: `${entry.name}/`, kind: "directory", size: 0 });
      }
    }

    const manifest: ArchiveManifest = {
      archive_version: ARCHIVE_VERSION,
      stageflow_version: PACKAGE_VERSION,
      created_at: createdAt,
      contains_secrets: includeSecrets && files.some((file) => ruleFor(file.path)?.kind === "secret"),
      home_id: readHomeId(homeDir),
      store_schema_version: schemaVersion,
      files,
      left_out: leftOut,
    };
    await tar.addBuffer("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), { mode: 0o600, mtimeSeconds: now.getTime() / 1000 });
    await tar.finish();
    gzip.end();
    await writing;

    rmSync(outPath, { force: true });
    renameSync(partial, outPath);
    chmodSync(outPath, 0o600);
    return {
      path: outPath,
      bytes: statSync(outPath).size,
      sha256: await sha256OfFile(outPath),
      created_at: createdAt,
      archive_version: ARCHIVE_VERSION,
      stageflow_version: PACKAGE_VERSION,
      contains_secrets: manifest.contains_secrets,
      file_count: files.length,
      left_out_count: leftOut.length,
    };
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isUnder(candidate: string, folder: string): boolean {
  const relative = path.relative(folder, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
