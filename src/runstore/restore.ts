import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
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
import { globalStageflowHome } from "../project/globalHome.js";
import { CURRENT_SCHEMA_VERSION } from "./sqlite/migrations/index.js";
import { StoreSchemaError } from "./sqlite/storeSchemaError.js";
import { assertStoreQuickCheck } from "./sqlite/applyStorePragmas.js";
import { verifyDbSnapshot } from "./backup.js";
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
  | "restore_failed"
  | "restore_not_found";

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

const ALLOWED_MEMBERS = new Set([
  "state.db",
  "settings.json",
  "agent/auth.json",
  "manifest.json",
]);

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

function majorVersion(version: string): string {
  return version.split(".")[0] ?? version;
}

async function gunzipToFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

function parseUstarMembers(tarPath: string, destDir: string): string[] {
  const buf = readFileSync(tarPath);
  const written: string[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = header.subarray(124, 135).toString("utf8").replace(/\0| /g, "");
    const size = Number.parseInt(sizeOctal, 8) || 0;
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
    if (!ALLOWED_MEMBERS.has(name) && name !== "") {
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
    writeFileSync(outPath, data);
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
  if (result === "up") {
    throw new RestoreError(
      "restore_host_live: Host is up (GET /livez). Stop it before restore.",
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

function moveAsideTriplet(homeDir: string, stamp: string): void {
  for (const name of ["state.db", "state.db-wal", "state.db-shm"] as const) {
    const from = path.join(homeDir, name);
    if (!existsSync(from)) continue;
    renameSync(from, `${from}.pre-restore-${stamp}`);
  }
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

export type ApplyRestoreResult = {
  schema_version: number;
  missing_a2a_artifact_rows: number;
  pre_restore_stamp: string;
};

export async function applyRestoreArchive(options: {
  archivePath: string;
  homeDir?: string;
  force?: boolean;
  restoreCredentials?: boolean;
  probe?: () => Promise<ServiceProbeResult>;
}): Promise<ApplyRestoreResult> {
  const homeDir = options.homeDir ?? globalStageflowHome();
  await assertHostDownForRestore({ probe: options.probe });

  const verified = await extractVerifiedArchive(options.archivePath);
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

    withExclusiveStoreLock(homeDir, () => {
      moveAsideTriplet(homeDir, stamp);
      const destDb = path.join(homeDir, "state.db");
      copyFileSync(verified.dbPath, destDb);
      assertNoSidecars(destDb);

      if (restoreCredentials) {
        const settingsSrc = path.join(verified.stagingDir, "settings.json");
        const authSrc = path.join(verified.stagingDir, "agent", "auth.json");
        if (existsSync(settingsSrc)) {
          copyFileSync(settingsSrc, path.join(homeDir, "settings.json"));
        }
        if (existsSync(authSrc)) {
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
    });

    const check = new Database(path.join(homeDir, "state.db"));
    try {
      assertStoreQuickCheck(check);
    } finally {
      check.close();
    }

    return {
      schema_version: verified.schemaVersion,
      missing_a2a_artifact_rows: verified.missingA2aArtifactRows,
      pre_restore_stamp: stamp,
    };
  } finally {
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

  const pending = restorePendingDir(homeDir);
  mkdirSync(pending, { recursive: true });
  const basename = `staged-${Date.now()}${path.extname(options.archivePath) || ".tar.gz"}`;
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
