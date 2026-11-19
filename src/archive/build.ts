import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Stats, mkdirSync, readFileSync, renameSync, rmSync, statSync, chmodSync } from "node:fs";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import Database from "better-sqlite3";
import { removeIdentitySecrets } from "../identity/archiveCopy.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { backupsDir, checkOutPath, verifyDbSnapshot } from "../runstore/backup.js";
import { readFilesystemSize } from "../runstore/diskUsage.js";
import type { RunStore } from "../runstore/port.js";
import { ARCHIVE_RULES, isDeniedRunPath, ruleFor, ruleMentions, type ArchiveRule } from "./inventory.js";
import { redactModelsJson } from "./redactModels.js";
import { TarStream } from "./tarStream.js";

export const ARCHIVE_VERSION = 1;
/** First member of every archive: lets a restore recognise one from its first header, without reading the whole file. */
export const ARCHIVE_MARKER = ".stageflow-archive";

export type ArchiveErrorCode = "archive_insufficient_space" | "archive_out_denied" | "archive_verify_failed";

export class ArchiveError extends Error {
  constructor(message: string, readonly code: ArchiveErrorCode, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "ArchiveError";
  }
}

export type ArchiveFileEntry = { path: string; kind: "file" | "symlink" | "directory"; size: number; sha256?: string; link?: string; note?: string };
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
  | { name: string; kind: "database"; source: string }
  | { name: string; kind: "redacted"; source: string; size: number; mode: number; mtime: number };

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

const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** lstat for a walk over a live directory: an entry that vanished since readdir listed it is skipped. */
async function lstatOrGone(file: string): Promise<Stats | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if (gone(error)) return undefined;
    throw error;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (gone(error)) return [];
    throw error;
  }
}

/**
 * Walks the data directory under the inventory rules and returns what to copy and what is left out, with a reason. The
 * walk is asynchronous, so a large tree never holds the Host's event loop; entries that vanish while it runs are skipped.
 */
export async function planArchive(homeDir: string, options: { includeSecrets: boolean; includeA2a: boolean }): Promise<{ entries: PlannedEntry[]; leftOut: ArchiveLeftOut[] }> {
  const entries: PlannedEntry[] = [];
  const leftOut: ArchiveLeftOut[] = [];

  const visit = async (relative: string, absolute: string): Promise<void> => {
    if (relative === "runs" || relative.startsWith("runs/")) return;
    if (SIDECAR.test(relative) || LEFTOVER.test(relative)) return;
    const found = await lstatOrGone(absolute);
    if (!found) return;
    const rule = ruleFor(found.isDirectory() ? `${relative}/` : relative) ?? ruleFor(relative);
    if (rule === undefined) {
      if (found.isDirectory() && ruleMentions(relative)) {
        for (const child of await listDir(absolute)) await visit(`${relative}/${child}`, path.join(absolute, child));
        return;
      }
      leftOut.push({ path: found.isDirectory() ? `${relative}/` : relative, reason: "not in the archive inventory" });
      return;
    }
    const decision = describe(rule, options);
    if (decision !== "include") {
      leftOut.push({ path: found.isDirectory() ? `${relative}/` : relative, reason: decision.reason });
      // A folder left out as secret can still hold a file that has its own "redacted" rule (agent/models.json): it goes in
      // without its credentials, and the rest of the folder stays out.
      if (found.isDirectory() && rule.kind === "secret") {
        for (const inner of ARCHIVE_RULES) {
          if (inner.kind !== "redacted" || !inner.path.startsWith(`${relative}/`)) continue;
          const file = await lstatOrGone(path.join(homeDir, ...inner.path.split("/")));
          if (file?.isFile()) entries.push({ name: inner.path, kind: "redacted", source: path.join(homeDir, ...inner.path.split("/")), size: file.size, mode: file.mode, mtime: file.mtimeMs / 1000 });
        }
      }
      return;
    }
    if (found.isSymbolicLink()) {
      entries.push({ name: relative, kind: "symlink", target: await readlink(absolute), mode: found.mode, mtime: found.mtimeMs / 1000 });
    } else if (found.isDirectory()) {
      const children = await listDir(absolute);
      if (children.length === 0) entries.push({ name: relative, kind: "directory", mode: found.mode, mtime: found.mtimeMs / 1000 });
      for (const child of children) await visit(`${relative}/${child}`, path.join(absolute, child));
    } else if (found.isFile()) {
      if (rule.kind === "database") entries.push({ name: relative, kind: "database", source: absolute });
      else if (rule.kind === "redacted" && !options.includeSecrets) entries.push({ name: relative, kind: "redacted", source: absolute, size: found.size, mode: found.mode, mtime: found.mtimeMs / 1000 });
      else entries.push({ name: relative, kind: "file", source: absolute, size: found.size, mode: found.mode, mtime: found.mtimeMs / 1000 });
    }
  };

  for (const child of await listDir(homeDir)) await visit(child, path.join(homeDir, child));

  // Files of one group (the MCP sign-in store and its key) go in together or not at all.
  const pairedGroups = new Set(ARCHIVE_RULES.filter((rule) => rule.group).map((rule) => rule.group!));
  for (const group of pairedGroups) {
    const rules = ARCHIVE_RULES.filter((rule) => rule.group === group);
    const onDisk: ArchiveRule[] = [];
    for (const rule of rules) if (await lstatOrGone(path.join(homeDir, rule.path))) onDisk.push(rule);
    if (onDisk.length === rules.length) continue;
    for (const rule of onDisk) {
      const index = entries.findIndex((entry) => entry.name === rule.path);
      if (index >= 0) {
        entries.splice(index, 1);
        if (!leftOut.some((item) => item.path === rule.path)) leftOut.push({ path: rule.path, reason: "left out because its pair is missing" });
      }
    }
  }
  return { entries, leftOut };
}

async function planRuns(store: BuildArchiveOptions["store"], homeDir: string, entries: PlannedEntry[], leftOut: ArchiveLeftOut[]): Promise<void> {
  for (const run of await store.listRuns()) {
    const workspace = store.getWorkspaceDir(run.run_id);
    const root = await lstatOrGone(workspace);
    if (!root || !root.isDirectory()) continue;
    const base = posix(path.relative(homeDir, workspace));
    if (base.startsWith("..") || path.isAbsolute(base)) continue;
    const walk = async (relative: string, absolute: string): Promise<void> => {
      const found = await lstatOrGone(absolute);
      if (!found) return;
      const name = `${base}/${relative}`;
      if (isDeniedRunPath(relative)) {
        leftOut.push({ path: found.isDirectory() ? `${name}/` : name, reason: "agent files, credentials and dependency or checkout folders are never copied from a run" });
        return;
      }
      if (found.isSymbolicLink()) entries.push({ name, kind: "symlink", target: await readlink(absolute), mode: found.mode, mtime: found.mtimeMs / 1000 });
      else if (found.isDirectory()) {
        const children = await listDir(absolute);
        if (children.length === 0) entries.push({ name, kind: "directory", mode: found.mode, mtime: found.mtimeMs / 1000 });
        for (const child of children) await walk(`${relative}/${child}`, path.join(absolute, child));
      } else if (found.isFile()) entries.push({ name, kind: "file", source: absolute, size: found.size, mode: found.mode, mtime: found.mtimeMs / 1000 });
    };
    for (const child of await listDir(workspace)) await walk(child, path.join(workspace, child));
  }
}

const IDENTITY_DB = "identity/consumer-identity.db";

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
 * The manifest's file list, written to disk as one JSON line per file while the archive is built. A workspace with a
 * million files would otherwise hold a manifest entry for each (about 250 bytes) and then a second copy as the JSON text.
 */
class ManifestFiles {
  count = 0;
  hasSecretKind = false;
  private readonly out;
  constructor(readonly file: string) {
    this.out = createWriteStream(file, { mode: 0o600 });
  }
  async add(entry: ArchiveFileEntry): Promise<void> {
    this.count += 1;
    if (["secret", "redacted"].includes(ruleFor(entry.path)?.kind ?? "")) this.hasSecretKind = true;
    if (!this.out.write(`${JSON.stringify(entry)}\n`)) await once(this.out, "drain");
  }
  async close(): Promise<void> {
    this.out.end();
    await once(this.out, "close");
  }
}

/** Writes manifest.json to `dest` in the same layout as JSON.stringify(manifest, null, 2), reading the file list line by line. */
async function writeManifestFile(dest: string, head: Omit<ArchiveManifest, "files" | "left_out">, files: ManifestFiles, leftOut: ArchiveLeftOut[]): Promise<void> {
  const out = createWriteStream(dest, { mode: 0o600 });
  const write = async (text: string): Promise<void> => {
    if (!out.write(text)) await once(out, "drain");
  };
  const indent = (text: string, spaces: number): string => text.replace(/^/gm, " ".repeat(spaces));
  const headText = JSON.stringify(head, null, 2);
  await write(`${headText.slice(0, headText.length - 2)},\n  "files": `);
  if (files.count === 0) {
    await write("[]");
  } else {
    await write("[\n");
    let first = true;
    for await (const line of createInterface({ input: createReadStream(files.file), crlfDelay: Infinity })) {
      if (line === "") continue;
      await write(`${first ? "" : ",\n"}${indent(JSON.stringify(JSON.parse(line), null, 2), 4)}`);
      first = false;
    }
    await write("\n  ]");
  }
  await write(`,\n  "left_out": ${leftOut.length === 0 ? "[]" : indent(JSON.stringify(leftOut, null, 2), 2).trimStart()}\n}\n`);
  out.end();
  await once(out, "close");
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

  const checked = checkOutPath(options.outPath ?? defaultArchiveOutPath(homeDir, now), homeDir);
  if (!checked.ok) throw new ArchiveError(`archive_out_denied: ${checked.reason}`, "archive_out_denied");
  const outPath = checked.resolved;
  mkdirSync(path.dirname(outPath), { recursive: true });

  const { entries, leftOut } = await planArchive(homeDir, { includeSecrets, includeA2a });
  await planRuns(options.store, homeDir, entries, leftOut);

  let estimate = 0;
  for (const entry of entries) estimate += entry.kind === "file" || entry.kind === "redacted" ? entry.size : entry.kind === "database" ? (await stat(entry.source)).size : 0;
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
    const digest = createHash("sha256");
    const hashing = new Transform({ transform(chunk: Buffer, _encoding, done) { digest.update(chunk); done(null, chunk); } });
    const writing = pipeline(gzip, hashing, out);
    const tar = new TarStream(gzip);
    const files = new ManifestFiles(path.join(staging, "manifest-files.ndjson"));
    let schemaVersion = 0;

    await tar.addBuffer(ARCHIVE_MARKER, Buffer.from(JSON.stringify({ archive_version: ARCHIVE_VERSION, stageflow_version: PACKAGE_VERSION })), { mode: 0o600, mtimeSeconds: now.getTime() / 1000 });
    for (const entry of entries) {
      if (entry.kind === "database") {
        const dest = path.join(staging, `${files.count}.db`);
        let version: number;
        if (entry.name === "state.db") {
          version = (await options.store.snapshotInto(dest)).userVersion;
          verifyDbSnapshot(dest, version);
          schemaVersion = version;
        } else {
          version = vacuumInto(entry.source, dest);
        }
        // The identity database keeps sign-in client secrets and refresh tokens in its rows; they follow the secret rule.
        const scrubbed = entry.name === IDENTITY_DB && !includeSecrets && removeIdentitySecrets(dest);
        if (entry.name === IDENTITY_DB && includeSecrets) files.hasSecretKind = true;
        const result = await tar.addFile(entry.name, dest, { mode: 0o600, mtimeSeconds: now.getTime() / 1000 });
        await files.add({ path: entry.name, kind: "file", size: result.size, sha256: result.sha256, ...(scrubbed ? { note: "sign-in client secrets and refresh tokens removed" } : {}) });
        rmSync(dest, { force: true });
      } else if (entry.kind === "redacted") {
        try {
          const redacted = redactModelsJson(await readFile(entry.source, "utf8"));
          if (redacted === undefined) {
            leftOut.push({ path: entry.name, reason: "not valid JSON or too large, so its keys could not be removed safely" });
            continue;
          }
          const result = await tar.addBuffer(entry.name, Buffer.from(redacted), { mode: 0o600, mtimeSeconds: entry.mtime });
          await files.add({ path: entry.name, kind: "file", size: result.size, sha256: result.sha256, note: "keys and headers removed" });
        } catch (error) {
          if (!gone(error)) throw error;
          leftOut.push({ path: entry.name, reason: "removed while the archive was being built" });
        }
      } else if (entry.kind === "file") {
        try {
          const result = await tar.addFile(entry.name, entry.source, { mode: entry.mode, mtimeSeconds: entry.mtime });
          await files.add({ path: entry.name, kind: "file", size: result.size, sha256: result.sha256 });
        } catch (error) {
          // The Host is live: a run purged or a file replaced since the walk is skipped, not fatal. Nothing was written for it.
          if (!gone(error)) throw error;
          leftOut.push({ path: entry.name, reason: "removed while the archive was being built" });
        }
      } else if (entry.kind === "symlink") {
        await tar.addSymlink(entry.name, entry.target, { mode: entry.mode, mtimeSeconds: entry.mtime });
        await files.add({ path: entry.name, kind: "symlink", size: 0, link: entry.target });
      } else {
        await tar.addDirectory(entry.name, { mode: entry.mode, mtimeSeconds: entry.mtime });
        await files.add({ path: `${entry.name}/`, kind: "directory", size: 0 });
      }
    }

    await files.close();
    const containsSecrets = includeSecrets && files.hasSecretKind;
    const manifestFile = path.join(staging, "manifest.json");
    await writeManifestFile(manifestFile, {
      archive_version: ARCHIVE_VERSION,
      stageflow_version: PACKAGE_VERSION,
      created_at: createdAt,
      contains_secrets: containsSecrets,
      home_id: readHomeId(homeDir),
      store_schema_version: schemaVersion,
    }, files, leftOut);
    await tar.addFile("manifest.json", manifestFile, { mode: 0o600, mtimeSeconds: now.getTime() / 1000 });
    await tar.finish();
    gzip.end();
    await writing;

    rmSync(outPath, { force: true });
    renameSync(partial, outPath);
    chmodSync(outPath, 0o600);
    return {
      path: outPath,
      bytes: statSync(outPath).size,
      sha256: digest.digest("hex"),
      created_at: createdAt,
      archive_version: ARCHIVE_VERSION,
      stageflow_version: PACKAGE_VERSION,
      contains_secrets: containsSecrets,
      file_count: files.count,
      left_out_count: leftOut.length,
    };
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
