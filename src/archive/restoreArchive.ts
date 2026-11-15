import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../package-meta.js";
import { readFilesystemSize } from "../runstore/diskUsage.js";
import { RestoreError } from "../runstore/restore.js";
import { assertStoreQuickCheck } from "../runstore/sqlite/applyStorePragmas.js";
import { CURRENT_SCHEMA_VERSION } from "../runstore/sqlite/migrations/index.js";
import { ARCHIVE_VERSION, type ArchiveManifest } from "./build.js";
import { isDeniedRunPath, ruleFor } from "./inventory.js";
import { readTarGz, type TarEntry } from "./tarReader.js";

const MANIFEST = "manifest.json";
const FREE_SPACE_MARGIN_BYTES = 8 * 1024 * 1024;

export type ScannedArchive = {
  manifest: ArchiveManifest;
  /** Files written under the staging directory (empty for a verify-only scan). */
  staged: Map<string, { mode: number }>;
  links: Array<{ name: string; target: string; mode: number }>;
  directories: Array<{ name: string; mode: number }>;
};

function parseVersion(version: string): [number, number] {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(major!) ? major! : 0, Number.isFinite(minor!) ? minor! : 0];
}

/** An archive from a newer Stageflow can hold data this one cannot open; `force` does not change that. */
export function assertArchiveCompatible(manifest: ArchiveManifest, force: boolean): void {
  if (manifest.archive_version !== ARCHIVE_VERSION) {
    throw new RestoreError(`restore_verify_failed: archive_version ${String(manifest.archive_version)} is not supported`, "restore_verify_failed");
  }
  const [archiveMajor, archiveMinor] = parseVersion(manifest.stageflow_version);
  const [major, minor] = parseVersion(PACKAGE_VERSION);
  if (archiveMajor > major || (archiveMajor === major && archiveMinor > minor)) {
    throw new RestoreError(
      `restore_schema_too_new: archive made by Stageflow ${manifest.stageflow_version}, this is ${PACKAGE_VERSION}; upgrade Stageflow first`,
      "restore_schema_too_new",
    );
  }
  if (archiveMajor !== major && !force) {
    throw new RestoreError(`restore_version_mismatch: archive ${manifest.stageflow_version} vs binary ${PACKAGE_VERSION} (pass --force)`, "restore_version_mismatch");
  }
}

/** A path an archive may carry. Anything else (disposable folders, lock files, odd names) is refused, not skipped. */
function assertAllowedName(name: string): void {
  const segments = name.split("/");
  const bad =
    name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0") ||
    segments.some((segment) => segment === ".." || segment === "." || segment === "");
  if (bad) throw new RestoreError(`restore_unsafe_member: ${name}`, "restore_unsafe_member");
  if (name === MANIFEST) return;
  if (name.startsWith("runs/")) {
    if (isDeniedRunPath(name.slice("runs/".length))) throw new RestoreError(`restore_unsafe_member: ${name} is not allowed inside a run`, "restore_unsafe_member");
    return;
  }
  const rule = ruleFor(name);
  if (!rule || rule.kind === "never") throw new RestoreError(`restore_unsafe_member: ${name} is not part of an archive`, "restore_unsafe_member");
}

async function discard(data: AsyncIterable<Buffer>): Promise<void> {
  for await (const chunk of data) void chunk;
}

/**
 * One pass over an archive. Checks every file against the manifest's size and SHA-256 and every entry against the allowed
 * names. With `stagingDir` the files are written there as they stream by; without it nothing is written.
 */
export async function scanArchive(archivePath: string, options: { stagingDir?: string; hash?: boolean } = {}): Promise<ScannedArchive> {
  const hashes = new Map<string, { size: number; sha256: string }>();
  const staged = new Map<string, { mode: number }>();
  const links: ScannedArchive["links"] = [];
  const directories: ScannedArchive["directories"] = [];
  let manifest: ArchiveManifest | undefined;
  const seen = new Set<string>();

  await readTarGz(archivePath, async (entry: TarEntry, data) => {
    if (entry.kind === "other") throw new RestoreError(`restore_unsafe_member: ${entry.name} is not a plain file, folder or symbolic link`, "restore_unsafe_member");
    const name = entry.kind === "directory" ? entry.name.replace(/\/$/, "") : entry.name;
    assertAllowedName(name);
    if (seen.has(name)) throw new RestoreError(`restore_verify_failed: ${name} appears twice`, "restore_verify_failed");
    seen.add(name);
    if (entry.kind === "symlink") {
      links.push({ name, target: entry.linkName, mode: entry.mode });
      return;
    }
    if (entry.kind === "directory") {
      directories.push({ name, mode: entry.mode });
      return;
    }
    if (name === MANIFEST) {
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(chunk);
      try {
        manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ArchiveManifest;
      } catch {
        throw new RestoreError("restore_verify_failed: manifest.json is not valid JSON", "restore_verify_failed");
      }
      return;
    }
    const hash = createHash("sha256");
    const dest = options.stagingDir ? path.join(options.stagingDir, ...name.split("/")) : undefined;
    const out = dest ? (mkdirSync(path.dirname(dest), { recursive: true }), createWriteStream(dest, { mode: 0o600 })) : undefined;
    let size = 0;
    for await (const chunk of data) {
      hash.update(chunk);
      size += chunk.length;
      if (out && !out.write(chunk)) await once(out, "drain");
    }
    if (out) {
      out.end();
      await once(out, "finish");
      staged.set(name, { mode: entry.mode });
    }
    hashes.set(name, { size, sha256: hash.digest("hex") });
  });

  if (!manifest) throw new RestoreError("restore_verify_failed: archive has no manifest.json", "restore_verify_failed");
  if (manifest.archive_version === undefined) throw new RestoreError("restore_verify_failed: manifest.json is not an archive manifest", "restore_verify_failed");
  const listed = new Map(manifest.files.map((file) => [file.path.replace(/\/$/, ""), file]));
  for (const [name, found] of hashes) {
    const expected = listed.get(name);
    if (!expected || expected.kind !== "file") throw new RestoreError(`restore_verify_failed: ${name} is not listed in the manifest`, "restore_verify_failed");
    if (expected.size !== found.size || expected.sha256 !== found.sha256) throw new RestoreError(`restore_verify_failed: ${name} does not match its checksum`, "restore_verify_failed");
  }
  for (const [name, expected] of listed) {
    if (!seen.has(name)) throw new RestoreError(`restore_verify_failed: ${name} is listed in the manifest but missing from the archive`, "restore_verify_failed");
    void expected;
  }
  return { manifest, staged, links, directories };
}

/** Returns the manifest when `archivePath` is an archive made by `sf archive`, and undefined for a backup or a bare database. */
export async function detectArchive(archivePath: string): Promise<ArchiveManifest | undefined> {
  if (!/\.(tar\.gz|tgz)$/i.test(archivePath)) return undefined;
  let manifest: ArchiveManifest | undefined;
  try {
    await readTarGz(archivePath, async (entry, data) => {
      if (entry.kind === "file" && entry.name === MANIFEST) {
        const chunks: Buffer[] = [];
        for await (const chunk of data) chunks.push(chunk);
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ArchiveManifest>;
          if (typeof parsed.archive_version === "number") manifest = parsed as ArchiveManifest;
        } catch { /* a backup manifest is JSON too; anything unreadable is not an archive */ }
        return;
      }
      await discard(data);
    });
  } catch {
    return undefined;
  }
  return manifest;
}

function verifyStoreFile(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assertStoreQuickCheck(db);
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new RestoreError(`restore_schema_too_new: store schema ${version} is newer than this Stageflow (${CURRENT_SCHEMA_VERSION})`, "restore_schema_too_new");
    }
    return version;
  } finally {
    db.close();
  }
}

export type StagedArchive = ScannedArchive & { stagingDir: string; schemaVersion: number };

/** Extracts and verifies an archive into `stagingDir`. Nothing outside it is touched. */
export async function stageArchive(archivePath: string, stagingDir: string, options: { force?: boolean; freeSpace?: (rootPath: string) => Promise<{ freeBytes: number }> } = {}): Promise<StagedArchive> {
  const manifest = await scanArchive(archivePath, {}).then((scanned) => scanned.manifest);
  assertArchiveCompatible(manifest, options.force === true);
  const needed = manifest.files.reduce((sum, file) => sum + (file.kind === "file" ? file.size : 0), 0) + FREE_SPACE_MARGIN_BYTES;
  const free = await (options.freeSpace ?? readFilesystemSize)(stagingDir);
  if (free.freeBytes < needed) {
    throw new RestoreError(`restore_insufficient_space: need about ${needed} bytes for the files, have ${free.freeBytes}`, "restore_insufficient_space", { needed_bytes: needed, free_bytes: free.freeBytes });
  }
  const scanned = await scanArchive(archivePath, { stagingDir });
  const stateDb = path.join(stagingDir, "state.db");
  if (!existsSync(stateDb)) throw new RestoreError("restore_verify_failed: archive has no state.db", "restore_verify_failed");
  const schemaVersion = verifyStoreFile(stateDb);
  return { ...scanned, stagingDir, schemaVersion };
}

function insideHome(homeDir: string, target: string): boolean {
  const relative = path.relative(homeDir, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The deepest existing parent must resolve inside the home, so a link already in the home cannot redirect a file out of it. */
function assertParentInside(homeDir: string, dest: string): void {
  let probe = path.dirname(dest);
  while (!existsSync(probe) && probe !== homeDir) probe = path.dirname(probe);
  const real = realpathSync(probe);
  const realHome = realpathSync(homeDir);
  if (real !== realHome && !insideHome(realHome, real)) throw new RestoreError(`restore_unsafe_member: ${dest} would land outside the data directory`, "restore_unsafe_member");
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

export type ApplyArchiveResult = { files_restored: number; links_restored: number; links_skipped: string[]; secrets_restored: number };

/**
 * Puts the staged files into the data directory. A file that already exists is moved aside as `<name>.pre-restore-<stamp>`;
 * files the archive does not carry stay as they are. Call it while the Host is down and the store lock is held.
 */
export function applyStagedArchive(options: {
  homeDir: string;
  staged: StagedArchive;
  stamp: string;
  restoreSecrets: boolean;
  moveAsideStore: () => void;
}): ApplyArchiveResult {
  const { homeDir, staged, stamp } = options;
  const result: ApplyArchiveResult = { files_restored: 0, links_restored: 0, links_skipped: [], secrets_restored: 0 };
  options.moveAsideStore();
  const names = [...staged.staged.keys()].sort();
  for (const name of names) {
    const dest = path.join(homeDir, ...name.split("/"));
    const secret = ruleFor(name)?.kind === "secret";
    if (secret && !options.restoreSecrets) continue;
    assertParentInside(homeDir, dest);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (existsSync(dest) || isLink(dest)) {
      if (name === "state.db") { /* already moved aside with its sidecars */ } else renameSync(dest, `${dest}.pre-restore-${stamp}`);
    }
    if (name.endsWith(".db") && name !== "state.db") {
      for (const side of ["-wal", "-shm"]) if (existsSync(`${dest}${side}`)) renameSync(`${dest}${side}`, `${dest}${side}.pre-restore-${stamp}`);
    }
    moveFile(path.join(staged.stagingDir, ...name.split("/")), dest);
    const mode = staged.staged.get(name)!.mode & 0o777;
    try { chmodSync(dest, secret ? 0o600 : mode || 0o644); } catch { /* best effort */ }
    result.files_restored += 1;
    if (secret) result.secrets_restored += 1;
  }
  for (const dir of staged.directories) {
    const dest = path.join(homeDir, ...dir.name.split("/"));
    assertParentInside(homeDir, dest);
    mkdirSync(dest, { recursive: true });
  }
  for (const link of staged.links) {
    const dest = path.join(homeDir, ...link.name.split("/"));
    const resolved = path.resolve(path.dirname(dest), link.target);
    if (path.isAbsolute(link.target) || !insideHome(homeDir, resolved) || (ruleFor(link.name)?.kind === "secret" && !options.restoreSecrets)) {
      result.links_skipped.push(link.name);
      continue;
    }
    assertParentInside(homeDir, dest);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (isLink(dest) || existsSync(dest)) renameSync(dest, `${dest}.pre-restore-${stamp}`);
    symlinkSync(link.target, dest);
    result.links_restored += 1;
  }
  return result;
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export function removeStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

