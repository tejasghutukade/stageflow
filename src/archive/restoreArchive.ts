import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../package-meta.js";
import { readFilesystemSize } from "../runstore/diskUsage.js";
import { RestoreError } from "../runstore/restore.js";
import { assertStoreQuickCheck } from "../runstore/sqlite/applyStorePragmas.js";
import { CURRENT_SCHEMA_VERSION } from "../runstore/sqlite/migrations/index.js";
import { ARCHIVE_MARKER, ARCHIVE_VERSION, type ArchiveManifest } from "./build.js";
import { isDeniedRunPath, ruleFor } from "./inventory.js";
import { readTarGz, type TarEntry } from "./tarReader.js";

const MANIFEST = "manifest.json";
const FREE_SPACE_MARGIN_BYTES = 8 * 1024 * 1024;

export type ArchiveMarker = { archive_version: number; stageflow_version: string };

export type ScannedArchive = {
  manifest: ArchiveManifest;
  marker: ArchiveMarker;
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
export function assertArchiveCompatible(version: { archive_version: number; stageflow_version: string }, force: boolean): void {
  if (version.archive_version !== ARCHIVE_VERSION) {
    throw new RestoreError(`restore_verify_failed: archive_version ${String(version.archive_version)} is not supported`, "restore_verify_failed");
  }
  const [archiveMajor, archiveMinor] = parseVersion(version.stageflow_version);
  const [major, minor] = parseVersion(PACKAGE_VERSION);
  if (archiveMajor > major || (archiveMajor === major && archiveMinor > minor)) {
    throw new RestoreError(
      `restore_schema_too_new: archive made by Stageflow ${version.stageflow_version}, this is ${PACKAGE_VERSION}; upgrade Stageflow first`,
      "restore_schema_too_new",
    );
  }
  if (archiveMajor !== major && !force) {
    throw new RestoreError(`restore_version_mismatch: archive ${version.stageflow_version} vs binary ${PACKAGE_VERSION} (pass --force)`, "restore_version_mismatch");
  }
}

/** A path an archive may carry. Anything else (disposable folders, lock files, odd names) is refused, not skipped. */
function assertAllowedName(name: string): void {
  const segments = name.split("/");
  const bad =
    name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0") ||
    segments.some((segment) => segment === ".." || segment === "." || segment === "");
  if (bad) throw new RestoreError(`restore_unsafe_member: ${name}`, "restore_unsafe_member");
  if (name === MANIFEST || name === ARCHIVE_MARKER) return;
  if (name.startsWith("runs/")) {
    if (isDeniedRunPath(name.slice("runs/".length))) throw new RestoreError(`restore_unsafe_member: ${name} is not allowed inside a run`, "restore_unsafe_member");
    return;
  }
  const rule = ruleFor(name);
  if (!rule || rule.kind === "never") throw new RestoreError(`restore_unsafe_member: ${name} is not part of an archive`, "restore_unsafe_member");
}

async function readAll(data: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of data) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMarker(bytes: Buffer): ArchiveMarker {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ArchiveMarker>;
    if (typeof parsed.archive_version === "number" && typeof parsed.stageflow_version === "string") return { archive_version: parsed.archive_version, stageflow_version: parsed.stageflow_version };
  } catch { /* falls through */ }
  throw new RestoreError(`restore_verify_failed: ${ARCHIVE_MARKER} is not valid`, "restore_verify_failed");
}

export type ScanOptions = {
  /** Write each file here as it streams by. Without it nothing is written. */
  stagingDir?: string;
  /** Stop with `restore_insufficient_space` once the files written would pass this many bytes. */
  limitBytes?: number;
  /** Called with the marker, before any file is read, so an archive that cannot be restored is refused without being unpacked. */
  onMarker?: (marker: ArchiveMarker) => void;
};

/**
 * One pass over an archive. The first member must be the marker; every file is checked against the manifest's size and
 * SHA-256, and every file, folder and link against the manifest and the allowed names. With `stagingDir` the files are
 * written there as they stream by.
 */
export async function scanArchive(archivePath: string, options: ScanOptions = {}): Promise<ScannedArchive> {
  const hashes = new Map<string, { size: number; sha256: string }>();
  const staged = new Map<string, { mode: number }>();
  const links: ScannedArchive["links"] = [];
  const directories: ScannedArchive["directories"] = [];
  let manifest: ArchiveManifest | undefined;
  let marker: ArchiveMarker | undefined;
  const seen = new Set<string>();
  let written = 0;
  let first = true;

  await readTarGz(archivePath, async (entry: TarEntry, data) => {
    if (entry.kind === "other") throw new RestoreError(`restore_unsafe_member: ${entry.name} is not a plain file, folder or symbolic link`, "restore_unsafe_member");
    const name = entry.kind === "directory" ? entry.name.replace(/\/$/, "") : entry.name;
    assertAllowedName(name);
    if (first) {
      first = false;
      if (name !== ARCHIVE_MARKER || entry.kind !== "file") throw new RestoreError("restore_verify_failed: not an sf archive (no marker as the first member)", "restore_verify_failed");
      marker = parseMarker(await readAll(data));
      options.onMarker?.(marker);
      seen.add(name);
      return;
    }
    if (name === ARCHIVE_MARKER) throw new RestoreError(`restore_verify_failed: ${ARCHIVE_MARKER} appears twice`, "restore_verify_failed");
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
      try {
        manifest = JSON.parse((await readAll(data)).toString("utf8")) as ArchiveManifest;
      } catch {
        throw new RestoreError("restore_verify_failed: manifest.json is not valid JSON", "restore_verify_failed");
      }
      return;
    }
    if (options.limitBytes !== undefined && written + entry.size > options.limitBytes) {
      throw new RestoreError(`restore_insufficient_space: the files need more room than the ${options.limitBytes} bytes available`, "restore_insufficient_space", { limit_bytes: options.limitBytes });
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
    written += size;
    hashes.set(name, { size, sha256: hash.digest("hex") });
  });

  if (!marker) throw new RestoreError("restore_verify_failed: not an sf archive", "restore_verify_failed");
  if (!manifest) throw new RestoreError("restore_verify_failed: archive has no manifest.json", "restore_verify_failed");
  if (manifest.archive_version !== marker.archive_version || manifest.stageflow_version !== marker.stageflow_version) {
    throw new RestoreError("restore_verify_failed: the marker and the manifest disagree about the archive's version", "restore_verify_failed");
  }
  const listed = new Map(manifest.files.map((file) => [file.path.replace(/\/$/, ""), file]));
  for (const [name, found] of hashes) {
    const expected = listed.get(name);
    if (!expected || expected.kind !== "file") throw new RestoreError(`restore_verify_failed: ${name} is not listed in the manifest as a file`, "restore_verify_failed");
    if (expected.size !== found.size || expected.sha256 !== found.sha256) throw new RestoreError(`restore_verify_failed: ${name} does not match its checksum`, "restore_verify_failed");
  }
  for (const link of links) {
    const expected = listed.get(link.name);
    if (!expected || expected.kind !== "symlink" || expected.link !== link.target) {
      throw new RestoreError(`restore_verify_failed: link ${link.name} is not in the manifest or points somewhere else`, "restore_verify_failed");
    }
  }
  for (const dir of directories) {
    if (listed.get(dir.name)?.kind !== "directory") throw new RestoreError(`restore_verify_failed: folder ${dir.name} is not listed in the manifest`, "restore_verify_failed");
  }
  for (const name of listed.keys()) {
    if (!seen.has(name)) throw new RestoreError(`restore_verify_failed: ${name} is listed in the manifest but missing from the archive`, "restore_verify_failed");
  }
  return { manifest, marker, staged, links, directories };
}

class StopReading extends Error {}

/** Reads only the first member: the archive's marker, or undefined for a backup, a bare database or an unreadable file. */
export async function detectArchive(archivePath: string): Promise<ArchiveMarker | undefined> {
  if (!/\.(tar\.gz|tgz)$/i.test(archivePath)) return undefined;
  let marker: ArchiveMarker | undefined;
  try {
    await readTarGz(archivePath, async (entry, data) => {
      if (entry.kind === "file" && entry.name === ARCHIVE_MARKER && entry.size <= 4096) {
        try {
          marker = parseMarker(await readAll(data));
        } catch { /* not a marker */ }
      }
      throw new StopReading();
    });
  } catch (error) {
    if (!(error instanceof StopReading)) return undefined;
  }
  return marker;
}

/** Checks an archive end to end (versions, names, every checksum) without writing anything. Used when a restore is staged for the next boot. */
export async function verifyArchive(archivePath: string, options: { force?: boolean } = {}): Promise<ArchiveManifest> {
  const scanned = await scanArchive(archivePath, { onMarker: (marker) => assertArchiveCompatible(marker, options.force === true) });
  return scanned.manifest;
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

/**
 * Extracts and verifies an archive into `stagingDir` in a single pass. A version that cannot be restored is refused from the
 * marker before anything is unpacked, and the pass stops as soon as the files would not fit. Nothing outside `stagingDir` is touched.
 */
export async function stageArchive(archivePath: string, stagingDir: string, options: { force?: boolean; freeSpace?: (rootPath: string) => Promise<{ freeBytes: number }> } = {}): Promise<StagedArchive> {
  const free = await (options.freeSpace ?? readFilesystemSize)(stagingDir);
  const scanned = await scanArchive(archivePath, {
    stagingDir,
    limitBytes: Math.max(0, free.freeBytes - FREE_SPACE_MARGIN_BYTES),
    onMarker: (marker) => assertArchiveCompatible(marker, options.force === true),
  });
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

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
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

type Plan = {
  files: string[];
  links: Array<{ name: string; target: string }>;
  skippedLinks: string[];
  directories: string[];
};

/** What would be placed, and what is refused. Throws for a destination that would land outside the data directory. */
function planPlacement(homeDir: string, staged: StagedArchive, restoreSecrets: boolean): Plan {
  const plan: Plan = { files: [], links: [], skippedLinks: [], directories: [] };
  for (const name of [...staged.staged.keys()].sort()) {
    if (ruleFor(name)?.kind === "secret" && !restoreSecrets) continue;
    assertParentInside(homeDir, path.join(homeDir, ...name.split("/")));
    plan.files.push(name);
  }
  for (const dir of staged.directories) {
    assertParentInside(homeDir, path.join(homeDir, ...dir.name.split("/")));
    plan.directories.push(dir.name);
  }
  for (const link of staged.links) {
    const dest = path.join(homeDir, ...link.name.split("/"));
    const resolved = path.resolve(path.dirname(dest), link.target);
    if (path.isAbsolute(link.target) || !insideHome(homeDir, resolved) || (ruleFor(link.name)?.kind === "secret" && !restoreSecrets)) {
      plan.skippedLinks.push(link.name);
      continue;
    }
    assertParentInside(homeDir, dest);
    plan.links.push({ name: link.name, target: link.target });
  }
  return plan;
}

/**
 * Everything that can be refused is refused here, before the first file is moved: a destination outside the data directory,
 * and not enough room in the data directory when the staged files have to be copied across filesystems.
 */
export async function preflightStagedArchive(options: { homeDir: string; staged: StagedArchive; restoreSecrets: boolean; freeSpace?: (rootPath: string) => Promise<{ freeBytes: number }> }): Promise<void> {
  const plan = planPlacement(options.homeDir, options.staged, options.restoreSecrets);
  if (statSync(options.staged.stagingDir).dev === statSync(options.homeDir).dev) return;
  let needed = FREE_SPACE_MARGIN_BYTES;
  for (const name of plan.files) needed += statSync(path.join(options.staged.stagingDir, ...name.split("/"))).size;
  const free = await (options.freeSpace ?? readFilesystemSize)(options.homeDir);
  if (free.freeBytes < needed) {
    throw new RestoreError(`restore_insufficient_space: the data directory needs about ${needed} bytes free to restore, has ${free.freeBytes}`, "restore_insufficient_space", { needed_bytes: needed, free_bytes: free.freeBytes });
  }
}

export type ApplyArchiveResult = { files_restored: number; links_restored: number; links_skipped: string[]; secrets_restored: number };

/**
 * Puts the staged files into the data directory. A file that already exists is moved aside as `<name>.pre-restore-<stamp>`;
 * files the archive does not carry stay as they are. Call it while the Host is down and the store lock is held.
 *
 * The store goes last: everything else is placed first, then `moveAsideStore` moves the old store away and `state.db` is
 * put in place. If anything fails, every move made so far is undone, and `rollback` undoes them later if a check made
 * after the apply fails.
 */
export function applyStagedArchive(options: {
  homeDir: string;
  staged: StagedArchive;
  stamp: string;
  restoreSecrets: boolean;
  /** Moves the old store aside and returns the function that moves it back. */
  moveAsideStore: () => () => void;
}): { result: ApplyArchiveResult; rollback: () => void } {
  const { homeDir, staged, stamp } = options;
  const plan = planPlacement(homeDir, staged, options.restoreSecrets);
  const undo: Array<() => void> = [];
  const rollback = (): void => {
    for (const step of undo.splice(0).reverse()) {
      try { step(); } catch { /* keep undoing the rest */ }
    }
  };
  const result: ApplyArchiveResult = { files_restored: 0, links_restored: 0, links_skipped: plan.skippedLinks, secrets_restored: 0 };

  /** Creates a folder and remembers which parts it created, so a rollback removes them again (only while they are empty). */
  const makeDir = (dir: string): void => {
    const created: string[] = [];
    for (let probe = dir; !existsSync(probe) && probe !== path.dirname(probe); probe = path.dirname(probe)) created.unshift(probe);
    mkdirSync(dir, { recursive: true });
    for (const made of created) undo.push(() => rmdirSync(made));
  };

  const place = (name: string): void => {
    const dest = path.join(homeDir, ...name.split("/"));
    const kind = ruleFor(name)?.kind;
    const secret = kind === "secret";
    const private0600 = secret || kind === "redacted";
    makeDir(path.dirname(dest));
    if (existsSync(dest) || isLink(dest)) {
      const aside = `${dest}.pre-restore-${stamp}`;
      renameSync(dest, aside);
      undo.push(() => renameSync(aside, dest));
    }
    if (name.endsWith(".db") && name !== "state.db") {
      for (const side of ["-wal", "-shm"]) {
        const from = `${dest}${side}`;
        if (!existsSync(from)) continue;
        renameSync(from, `${from}.pre-restore-${stamp}`);
        undo.push(() => renameSync(`${from}.pre-restore-${stamp}`, from));
      }
    }
    moveFile(path.join(staged.stagingDir, ...name.split("/")), dest);
    undo.push(() => rmSync(dest, { force: true }));
    try { chmodSync(dest, private0600 ? 0o600 : (staged.staged.get(name)!.mode & 0o777) || 0o644); } catch { /* best effort */ }
    result.files_restored += 1;
    if (secret) result.secrets_restored += 1;
  };

  try {
    for (const name of plan.files) if (name !== "state.db") place(name);
    for (const dir of plan.directories) makeDir(path.join(homeDir, ...dir.split("/")));
    for (const link of plan.links) {
      const dest = path.join(homeDir, ...link.name.split("/"));
      makeDir(path.dirname(dest));
      if (isLink(dest) || existsSync(dest)) {
        const aside = `${dest}.pre-restore-${stamp}`;
        renameSync(dest, aside);
        undo.push(() => renameSync(aside, dest));
      }
      symlinkSync(link.target, dest);
      undo.push(() => rmSync(dest, { force: true }));
      result.links_restored += 1;
    }
    if (plan.files.includes("state.db")) {
      undo.push(options.moveAsideStore());
      place("state.db");
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return { result, rollback };
}

export function removeStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
