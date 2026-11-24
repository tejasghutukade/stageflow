import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../package-meta.js";
import { globalCredentialRoot, globalStageflowHome } from "../project/globalHome.js";
import { isUsableAuthFile } from "../runtime/credentialBinding.js";
import { CURRENT_SCHEMA_VERSION } from "./sqlite/migrations/index.js";
import { StoreSchemaError } from "./sqlite/storeSchemaError.js";
import { assertStoreQuickCheck } from "./sqlite/applyStorePragmas.js";
import {
  verifyPublishedArtifactIntegrityAfterRestore,
  type RestoreIntegrityFinding,
} from "../artifacts/storeInventory.js";
import { ensureArtifactSearchIndex } from "../artifacts/search.js";
import { verifyDbSnapshot } from "./backup.js";
import { acquireHostLock, HostLockError, type HostLock } from "../server/hostLock.js";
import {
  probeGlobalServiceDetailed,
  type ServiceProbeResult,
} from "../server/ensureGlobalService.js";

export type RestoreErrorCode =
  | "restore_host_live"
  | "restore_store_busy"
  | "restore_verify_failed"
  | "restore_schema_too_new"
  | "restore_version_mismatch"
  | "restore_unsafe_member"
  | "restore_bad_member"
  | "restore_failed"
  | "restore_not_found"
  | "restore_insufficient_space";

export class RestoreError extends Error {
  readonly code: RestoreErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(
    message: string,
    code: RestoreErrorCode,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RestoreError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export type RestoreManifest = {
  created_at?: string;
  stageflow_version?: string;
  schema_version?: number;
  contents?: string[];
  credentials_included?: boolean;
  a2a_artifacts_included?: boolean;
  fingerprint_skew?: boolean;
};

export type VerifiedRestoreArchive = {
  stagingDir: string;
  dbPath: string;
  manifest: RestoreManifest | null;
  schemaVersion: number;
  missingA2aArtifactRows: number;
};

/** Practical ceiling for the in-memory ustar reader. Larger archives are refused before the file is loaded. */
export const RESTORE_DECOMPRESSED_MAX_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

const ALLOWED_TOP_LEVEL = new Set([
  "state.db",
  "settings.json",
  "agent/auth.json",
  "manifest.json",
]);

function isAllowedRestoreMember(name: string): boolean {
  if (ALLOWED_TOP_LEVEL.has(name)) return true;
  if (name.startsWith("artifacts/")) return true;
  return false;
}

export function restorePendingDir(
  homeDir: string = globalStageflowHome(),
): string {
  return path.join(homeDir, "restore-pending");
}

export function restoreMarkerPath(
  homeDir: string = globalStageflowHome(),
): string {
  return path.join(restorePendingDir(homeDir), "marker.json");
}

export function restoreAppliedPath(
  homeDir: string = globalStageflowHome(),
): string {
  return path.join(homeDir, "restore.applied");
}

export function restoreFailedPath(
  homeDir: string = globalStageflowHome(),
): string {
  return path.join(homeDir, "restore.failed");
}

export type RestoreMarker = {
  archive: string;
  attempts: number;
  staged_at: string;
  drain_deadline?: string;
};

/** `path.extname` of `x.tar.gz` is `.gz`, which the restore would then read as a bare database. */
function stagedExtension(file: string): string {
  return /\.tar\.gz$/i.test(file) ? ".tar.gz" : path.extname(file) || ".tar.gz";
}

function majorVersion(version: string): string {
  return version.split(".")[0] ?? version;
}

async function gunzipToFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

function tarMemberSize(header: Buffer): number {
  const sizeOctal = header.subarray(124, 135).toString("utf8").replace(/\0| /g, "");
  return Number.parseInt(sizeOctal, 8) || 0;
}

function assertDecompressedTarLimit(tarPath: string): void {
  const fd = openSync(tarPath, "r");
  try {
    const sizeOnDisk = statSync(tarPath).size;
    const header = Buffer.alloc(512);
    let offset = 0;
    let total = 0;
    while (offset + 512 <= sizeOnDisk) {
      const read = readSync(fd, header, 0, 512, offset);
      if (read < 512) break;
      offset += 512;
      if (header.every((byte) => byte === 0)) break;
      const size = tarMemberSize(header);
      total += size;
      if (total > RESTORE_DECOMPRESSED_MAX_BYTES) {
        throw new RestoreError(
          "restore_failed: decompressed archive exceeds 1.5 GiB",
          "restore_failed",
        );
      }
      offset += size + ((512 - (size % 512)) % 512);
    }
  } finally {
    closeSync(fd);
  }
}

function parseUstarMembers(tarPath: string, destDir: string): string[] {
  assertDecompressedTarLimit(tarPath);
  const buf = readFileSync(tarPath);
  const written: string[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = tarMemberSize(header);
    const type = header[156];
    if (name.includes("..") || path.isAbsolute(name) || name.startsWith("/")) {
      throw new RestoreError(
        `restore_unsafe_member: ${name}`,
        "restore_unsafe_member",
      );
    }
    if (type === 0x32 /* symlink */ || type === 0x31 /* hard link */) {
      throw new RestoreError(
        `restore_unsafe_member: link ${name}`,
        "restore_unsafe_member",
      );
    }
    if (type === 0x33 || type === 0x34 || type === 0x36) {
      throw new RestoreError(
        `restore_unsafe_member: ${name}`,
        "restore_unsafe_member",
      );
    }
    if (type === 0x35 /* directory */ || name.endsWith("/")) {
      throw new RestoreError(
        `restore_bad_member: directory ${name}`,
        "restore_bad_member",
      );
    }
    if (!isAllowedRestoreMember(name) && name !== "") {
      throw new RestoreError(
        `restore_unsafe_member: ${name} not in allowlist`,
        "restore_unsafe_member",
      );
    }
    const data = buf.subarray(offset, offset + size);
    offset += size + ((512 - (size % 512)) % 512);
    if (name === "") continue;
    const outPath = path.join(destDir, name);
    mkdirSync(path.dirname(outPath), { recursive: true });
    if (existsSync(outPath)) {
      throw new RestoreError(`restore_bad_member: ${name}`, "restore_bad_member");
    }
    try {
      writeFileSync(outPath, data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EEXIST" || code === "EISDIR") {
        throw new RestoreError(
          `restore_bad_member: ${name}`,
          "restore_bad_member",
        );
      }
      throw error;
    }
    written.push(name);
  }
  return written;
}

export async function extractVerifiedArchive(
  archivePath: string,
): Promise<VerifiedRestoreArchive> {
  const stagingDir = await mkdtemp(path.join(tmpdir(), "sf-restore-"));
  try {
    let dbPath = archivePath;
    let manifest: RestoreManifest | null = null;

    if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
      const tarPath = path.join(stagingDir, "archive.tar");
      await gunzipToFile(archivePath, tarPath);
      parseUstarMembers(tarPath, stagingDir);
      dbPath = path.join(stagingDir, "state.db");
      const manifestFile = path.join(stagingDir, "manifest.json");
      if (existsSync(manifestFile)) {
        manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as RestoreManifest;
      }
    } else {
      const copied = path.join(stagingDir, "state.db");
      copyFileSync(archivePath, copied);
      dbPath = copied;
    }

    if (!existsSync(dbPath)) {
      throw new RestoreError(
        "restore_verify_failed: archive missing state.db",
        "restore_verify_failed",
      );
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let schemaVersion: number;
    try {
      assertStoreQuickCheck(db);
      schemaVersion = db.pragma("user_version", { simple: true }) as number;
    } finally {
      db.close();
    }

    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new StoreSchemaError(
        `store_schema_too_new: on_disk=${schemaVersion} binary_max=${CURRENT_SCHEMA_VERSION}`,
        "store_schema_too_new",
      );
    }

    verifyDbSnapshot(dbPath, schemaVersion);

    let missingA2aArtifactRows = 0;
    if (manifest && manifest.a2a_artifacts_included !== true) {
      const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = probe
          .prepare(
            "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='a2a_artifacts'",
          )
          .get() as { c: number };
        if (row.c > 0) {
          const count = probe
            .prepare("SELECT COUNT(*) AS c FROM a2a_artifacts")
            .get() as { c: number };
          missingA2aArtifactRows = count.c;
        }
      } catch {
        missingA2aArtifactRows = 0;
      } finally {
        probe.close();
      }
    }

    return {
      stagingDir,
      dbPath,
      manifest,
      schemaVersion,
      missingA2aArtifactRows,
    };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export async function assertHostDownForRestore(options?: {
  probe?: () => Promise<ServiceProbeResult>;
}): Promise<void> {
  const probe = options?.probe ?? probeGlobalServiceDetailed;
  const result = await probe();
  // Only "nothing is listening" is safe. An older Host, another data directory, or a Host still booting all count as live.
  if (result !== "unreachable") {
    throw new RestoreError(
      `restore_host_live: something answers on the Host port (${result}). Stop the Host before restore.`,
      "restore_host_live",
    );
  }
}

/**
 * Open an exclusive lock on state.db with busy_timeout=0 and hold it through
 * the provided callback (used to relocate the DB triplet safely).
 */
export function withExclusiveStoreLock<T>(
  homeDir: string,
  fn: () => T,
): T {
  const dbPath = path.join(homeDir, "state.db");
  if (!existsSync(dbPath)) {
    return fn();
  }
  const lockDb = new Database(dbPath);
  try {
    lockDb.pragma("busy_timeout = 0");
    try {
      lockDb.prepare("BEGIN EXCLUSIVE").run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/SQLITE_BUSY|database is locked/i.test(message)) {
        throw new RestoreError(
          "restore_store_busy: another process holds state.db",
          "restore_store_busy",
        );
      }
      throw err;
    }
    return fn();
  } finally {
    try {
      lockDb.exec("ROLLBACK");
    } catch {
      // ignore
    }
    lockDb.close();
  }
}

/** Moves the store aside and returns the function that moves it back. */
function moveAsideTriplet(homeDir: string, stamp: string): () => void {
  const moved: Array<[string, string]> = [];
  for (const name of ["state.db", "state.db-wal", "state.db-shm"] as const) {
    const from = path.join(homeDir, name);
    if (!existsSync(from)) continue;
    const to = `${from}.pre-restore-${stamp}`;
    renameSync(from, to);
    moved.push([from, to]);
  }
  return () => {
    for (const [from, to] of moved.reverse()) {
      if (existsSync(from)) rmSync(from, { force: true });
      renameSync(to, from);
    }
  };
}

function assertNoSidecars(dbPath: string): void {
  for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(side)) {
      unlinkSync(side);
    }
  }
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
    throw new RestoreError(
      "restore_verify_failed: stale WAL/SHM sidecars remain",
      "restore_verify_failed",
    );
  }
}

export type RestoreWarning = {
  code: string;
  message: string;
};

export type ApplyRestoreResult = {
  schema_version: number;
  missing_a2a_artifact_rows: number;
  pre_restore_stamp: string;
  warnings?: RestoreWarning[];
  published_artifact_integrity?: RestoreIntegrityFinding[];
  /** Set when the file was an `sf archive` archive rather than a backup. */
  kind?: "archive";
  files_restored?: number;
  links_restored?: number;
  links_skipped?: string[];
  secrets_restored?: number;
};

function stagingHasPublishedArtifacts(stagingDir: string): boolean {
  const root = path.join(stagingDir, "artifacts");
  if (!existsSync(root)) return false;
  try {
    return readdirSync(root).length > 0;
  } catch {
    return false;
  }
}

const ARTIFACTS_LEFT_IN_PLACE: RestoreWarning = {
  code: "artifacts_not_in_backup",
  message:
    "Backup has no published artifact content. Existing artifact files were left in place. Restored rows may reference content that is missing.",
};

let artifactSwapFault: (() => void) | undefined;

export function setRestoreArtifactSwapFaultForTests(fn?: () => void): void {
  artifactSwapFault = fn;
}

function verifyTreeCopy(src: string, dest: string): void {
  const walk = (relative: string): void => {
    const from = relative.length === 0 ? src : path.join(src, relative);
    const to = relative.length === 0 ? dest : path.join(dest, relative);
    const st = statSync(from);
    if (st.isDirectory()) {
      if (!existsSync(to) || !statSync(to).isDirectory()) {
        throw new RestoreError(
          `restore_verify_failed: staged artifact tree missing ${relative || "."}`,
          "restore_verify_failed",
        );
      }
      for (const name of readdirSync(from)) walk(relative.length === 0 ? name : path.join(relative, name));
      return;
    }
    if (!st.isFile()) return;
    if (!existsSync(to) || !statSync(to).isFile() || statSync(to).size !== st.size) {
      throw new RestoreError(
        `restore_verify_failed: staged artifact file mismatch ${relative}`,
        "restore_verify_failed",
      );
    }
  };
  walk("");
}

function removeStagedArtifacts(staged: string | undefined): void {
  if (staged !== undefined && existsSync(staged)) rmSync(staged, { recursive: true, force: true });
}

function stageArtifactTree(homeDir: string, stagingDir: string, stamp: string): string {
  const srcRoot = path.join(stagingDir, "artifacts");
  const staged = path.join(homeDir, `.artifacts-incoming-${stamp}`);
  try {
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true });
    copyTreeSync(srcRoot, staged);
    verifyTreeCopy(srcRoot, staged);
    return staged;
  } catch (error) {
    removeStagedArtifacts(staged);
    throw error;
  }
}

function commitRestoredArtifactTree(homeDir: string, staged: string, stamp: string): void {
  const dest = path.join(homeDir, "artifacts");
  const aside = `${dest}.pre-restore-${stamp}`;
  const had = existsSync(dest);
  if (had) renameSync(dest, aside);
  try {
    artifactSwapFault?.();
    renameSync(staged, dest);
  } catch (error) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    if (had && existsSync(aside)) renameSync(aside, dest);
    const message = error instanceof Error ? error.message : String(error);
    throw error instanceof RestoreError
      ? error
      : new RestoreError(`restore_failed: ${message}`, "restore_failed");
  }
  if (had && existsSync(aside)) rmSync(aside, { recursive: true, force: true });
}

function copyTreeSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      copyTreeSync(from, to);
    } else if (st.isFile()) {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      try {
        chmodSync(to, st.mode);
      } catch {
        // best-effort
      }
    }
  }
}

export async function applyRestoreArchive(options: {
  archivePath: string;
  homeDir?: string;
  force?: boolean;
  restoreCredentials?: boolean;
  probe?: () => Promise<ServiceProbeResult>;
}): Promise<ApplyRestoreResult> {
  const homeDir = options.homeDir ?? globalStageflowHome();
  await assertHostDownForRestore({ probe: options.probe });
  // A Host on another port still holds the data directory's lock: refuse, and hold it ourselves while we restore.
  let hostLock: HostLock;
  try {
    hostLock = await acquireHostLock(homeDir);
  } catch (err) {
    if (err instanceof HostLockError) {
      throw new RestoreError(`restore_host_live: ${err.message}`, "restore_host_live");
    }
    throw err;
  }

  const archives = await import("../archive/restoreArchive.js");
  if (await archives.detectArchive(options.archivePath)) {
    const stagingDir = await mkdtemp(path.join(tmpdir(), "sf-restore-"));
    try {
      const staged = await archives.stageArchive(options.archivePath, stagingDir, { force: options.force === true });
      const restoreSecrets = options.restoreCredentials !== false;
      await archives.preflightStagedArchive({ homeDir, staged, restoreSecrets });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let applied: ReturnType<typeof archives.applyStagedArchive> | undefined;
      withExclusiveStoreLock(homeDir, () => {
        applied = archives.applyStagedArchive({ homeDir, staged, stamp, restoreSecrets, moveAsideStore: () => moveAsideTriplet(homeDir, stamp) });
      });
      try {
        assertNoSidecars(path.join(homeDir, "state.db"));
        const check = new Database(path.join(homeDir, "state.db"));
        try {
          assertStoreQuickCheck(check);
        } finally {
          check.close();
        }
      } catch (error) {
        applied!.rollback();
        throw error;
      }
      return { schema_version: staged.schemaVersion, missing_a2a_artifact_rows: 0, pre_restore_stamp: stamp, kind: "archive", ...applied!.result };
    } finally {
      hostLock.release();
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  const verified = await extractVerifiedArchive(options.archivePath).catch((err: unknown) => {
    hostLock.release();
    throw err;
  });
  try {
    if (
      verified.manifest?.stageflow_version &&
      majorVersion(verified.manifest.stageflow_version) !==
        majorVersion(PACKAGE_VERSION) &&
      options.force !== true
    ) {
      throw new RestoreError(
        `restore_version_mismatch: archive ${verified.manifest.stageflow_version} vs binary ${PACKAGE_VERSION} (pass --force)`,
        "restore_version_mismatch",
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const restoreCredentials = options.restoreCredentials !== false;
    const hasArtifactContent = stagingHasPublishedArtifacts(verified.stagingDir);
    const stagedArtifacts = hasArtifactContent ? stageArtifactTree(homeDir, verified.stagingDir, stamp) : undefined;
    const warnings: RestoreWarning[] = hasArtifactContent ? [] : [ARTIFACTS_LEFT_IN_PLACE];

    try {
    withExclusiveStoreLock(homeDir, () => {
      const rollbackDb = moveAsideTriplet(homeDir, stamp);
      try {
      const destDb = path.join(homeDir, "state.db");
      copyFileSync(verified.dbPath, destDb);
      assertNoSidecars(destDb);
      if (stagedArtifacts !== undefined) {
        commitRestoredArtifactTree(homeDir, stagedArtifacts, stamp);
      }

      if (restoreCredentials) {
        const settingsSrc = path.join(verified.stagingDir, "settings.json");
        const authSrc = path.join(verified.stagingDir, "agent", "auth.json");
        if (existsSync(settingsSrc)) {
          copyFileSync(settingsSrc, path.join(homeDir, "settings.json"));
        }
        const restoreAuth =
          path.resolve(homeDir) === path.resolve(globalCredentialRoot()) &&
          isUsableAuthFile(authSrc);
        if (restoreAuth) {
          const agentDir = path.join(homeDir, "agent");
          mkdirSync(agentDir, { recursive: true });
          try {
            chmodSync(agentDir, 0o700);
          } catch {
            // best-effort
          }
          const authDest = path.join(agentDir, "auth.json");
          copyFileSync(authSrc, authDest);
          try {
            chmodSync(authDest, 0o600);
          } catch {
            // best-effort
          }
        }
      }
      } catch (error) {
        try {
          rollbackDb();
        } catch (rollbackError) {
          const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new RestoreError(
            `restore_failed: ${detail}`,
            "restore_failed",
          );
        }
        removeStagedArtifacts(stagedArtifacts);
        throw error;
      }
    });
    } catch (error) {
      removeStagedArtifacts(stagedArtifacts);
      throw error;
    }

    const check = new Database(path.join(homeDir, "state.db"));
    let published_artifact_integrity: RestoreIntegrityFinding[] = [];
    try {
      assertStoreQuickCheck(check);
      ensureArtifactSearchIndex(check);
      published_artifact_integrity = await verifyPublishedArtifactIntegrityAfterRestore(check, homeDir);
    } finally {
      check.close();
    }

    return {
      schema_version: verified.schemaVersion,
      missing_a2a_artifact_rows: verified.missingA2aArtifactRows,
      pre_restore_stamp: stamp,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(published_artifact_integrity.length > 0 ? { published_artifact_integrity } : {}),
    };
  } finally {
    hostLock.release();
    await rm(verified.stagingDir, { recursive: true, force: true });
  }
}

export async function stageRestoreForBoot(options: {
  archivePath: string;
  homeDir?: string;
  graceMs?: number;
}): Promise<{ marker: RestoreMarker; stagedPath: string }> {
  const homeDir = options.homeDir ?? globalStageflowHome();
  if (existsSync(restoreFailedPath(homeDir))) {
    throw new RestoreError(
      "restore_failed: clear restore.failed before staging another restore",
      "restore_failed",
    );
  }

  const archives = await import("../archive/restoreArchive.js");
  if (await archives.detectArchive(options.archivePath)) {
    // One pass: versions, names and every checksum, writing nothing. The files are unpacked once, at the next boot.
    await archives.verifyArchive(options.archivePath);
  } else {
    const verified = await extractVerifiedArchive(options.archivePath);
    await rm(verified.stagingDir, { recursive: true, force: true });

    if (
      verified.manifest?.stageflow_version &&
      majorVersion(verified.manifest.stageflow_version) !==
        majorVersion(PACKAGE_VERSION)
    ) {
      throw new RestoreError(
        `restore_version_mismatch: archive ${verified.manifest.stageflow_version} vs binary ${PACKAGE_VERSION}`,
        "restore_version_mismatch",
      );
    }

  }

  const pending = restorePendingDir(homeDir);
  mkdirSync(pending, { recursive: true });
  const basename = `staged-${Date.now()}${stagedExtension(options.archivePath)}`;
  const stagedPath = path.join(pending, basename);
  copyFileSync(options.archivePath, stagedPath);

  const graceMs = options.graceMs ?? 8000;
  const marker: RestoreMarker = {
    archive: basename,
    attempts: 0,
    staged_at: new Date().toISOString(),
    drain_deadline: new Date(Date.now() + graceMs).toISOString(),
  };
  writeFileSync(restoreMarkerPath(homeDir), `${JSON.stringify(marker, null, 2)}\n`);
  return { marker, stagedPath };
}

export async function resolveBackupNameForRestore(
  name: string,
  homeDir: string = globalStageflowHome(),
): Promise<string> {
  const { resolveBackupDownloadPath } = await import("./backup.js");
  return resolveBackupDownloadPath(name, homeDir);
}

export type BootRestoreOutcome =
  | { status: "none" }
  | { status: "applied"; result: ApplyRestoreResult }
  | { status: "failed"; reason: string; attempts: number }
  | { status: "blocked"; reason: string };

/**
 * Apply a staged restore marker before opening the store for serving.
 * Never re-applies restore.applied. Two failures → restore.failed (hard non-serve).
 */
export async function applyPendingRestoreAtBoot(
  homeDir: string = globalStageflowHome(),
): Promise<BootRestoreOutcome> {
  if (existsSync(restoreFailedPath(homeDir))) {
    const raw = readFileSync(restoreFailedPath(homeDir), "utf8");
    let reason = "restore.failed present";
    try {
      reason = (JSON.parse(raw) as { reason?: string }).reason ?? reason;
    } catch {
      // keep default
    }
    return { status: "blocked", reason };
  }

  if (existsSync(restoreAppliedPath(homeDir))) {
    return { status: "none" };
  }

  const markerFile = restoreMarkerPath(homeDir);
  if (!existsSync(markerFile)) {
    return { status: "none" };
  }

  const marker = JSON.parse(readFileSync(markerFile, "utf8")) as RestoreMarker;
  const archivePath = path.join(restorePendingDir(homeDir), marker.archive);
  marker.attempts += 1;
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);

  try {
    if (!existsSync(archivePath)) {
      throw new RestoreError(
        `restore_not_found: staged archive missing (${marker.archive})`,
        "restore_not_found",
      );
    }
    const result = await applyRestoreArchive({
      archivePath,
      homeDir,
      force: true,
      probe: async () => "unreachable",
    });
    writeFileSync(
      restoreAppliedPath(homeDir),
      `${JSON.stringify({ ...result, applied_at: new Date().toISOString() }, null, 2)}\n`,
    );
    rmSync(markerFile, { force: true });
    return { status: "applied", result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (marker.attempts >= 2) {
      writeFileSync(
        restoreFailedPath(homeDir),
        `${JSON.stringify({ reason, attempts: marker.attempts, at: new Date().toISOString() }, null, 2)}\n`,
      );
      rmSync(markerFile, { force: true });
      return { status: "failed", reason, attempts: marker.attempts };
    }
    return { status: "failed", reason, attempts: marker.attempts };
  }
}
