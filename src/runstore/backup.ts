import { createHash } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../package-meta.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { readFilesystemSize } from "./diskUsage.js";
import type { RunStore } from "./port.js";
import { isInsideDir } from "./workspaceLayout.js";

export type BackupErrorCode =
  | "backup_insufficient_disk"
  | "backup_verify_failed"
  | "backup_out_denied"
  | "backup_cross_device"
  | "backup_fingerprint_skew";

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(
    message: string,
    code: BackupErrorCode,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export type BackupContentsFlag =
  | "state.db"
  | "settings.json"
  | "agent/auth.json"
  | "a2a-artifacts"
  | "manifest.json";

export type BackupManifest = {
  created_at: string;
  stageflow_version: string;
  schema_version: number;
  contents: BackupContentsFlag[];
  db_only: boolean;
  credentials_included: boolean;
  a2a_artifacts_included: boolean;
  settings_fingerprint_before: string | null;
  settings_fingerprint_after: string | null;
  auth_fingerprint_before: string | null;
  auth_fingerprint_after: string | null;
  fingerprint_skew: boolean;
  secret_warning: string;
};

export type BackupResult = {
  path: string;
  bytes: number;
  sha256: string;
  schema_version: number;
  stageflow_version: string;
  created_at: string;
  contents: BackupContentsFlag[];
};

export type CreateBackupOptions = {
  store: RunStore;
  homeDir?: string;
  outPath?: string;
  dbOnly?: boolean;
  noCredentials?: boolean;
  includeA2aArtifacts?: boolean;
  freeSpace?: (rootPath: string) => Promise<{ freeBytes: number }>;
  now?: () => Date;
};

const SECRET_WARNING =
  "This backup may contain provider credentials and must be treated as a secret.";

const FREE_SPACE_MARGIN_BYTES = 8 * 1024 * 1024;

export function backupsDir(homeDir: string = globalStageflowHome()): string {
  return path.join(homeDir, "backups");
}

export function defaultBackupOutPath(
  homeDir: string = globalStageflowHome(),
  now: Date = new Date(),
  dbOnly = false,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const ext = dbOnly ? ".db" : ".tar.gz";
  return path.join(backupsDir(homeDir), `stageflow-${stamp}${ext}`);
}

export function assertBackupOutPathAllowed(
  outPath: string,
  homeDir: string = globalStageflowHome(),
): string {
  const segments = outPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new BackupError(
      "backup_out_denied: path must not contain .. segments",
      "backup_out_denied",
    );
  }
  const resolved = path.resolve(outPath);
  const worktrees = path.resolve(homeDir, "worktrees");
  const runs = path.resolve(homeDir, "runs");
  if (isInsideDir(resolved, worktrees) || isInsideDir(resolved, runs)) {
    throw new BackupError(
      "backup_out_denied: refusing to write under worktrees/ or runs/",
      "backup_out_denied",
      { path: resolved },
    );
  }
  return resolved;
}

function fingerprint(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const st = statSync(filePath);
  return `${st.size}:${Math.trunc(st.mtimeMs)}`;
}

function stateDbTripletBytes(homeDir: string): number {
  let total = 0;
  for (const name of ["state.db", "state.db-wal", "state.db-shm"] as const) {
    const p = path.join(homeDir, name);
    if (!existsSync(p)) continue;
    total += statSync(p).size;
  }
  return total;
}

export function verifyDbSnapshot(
  snapshotPath: string,
  expectedUserVersion: number,
): void {
  const db = new Database(snapshotPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const qc = db.pragma("quick_check", { simple: true });
    if (qc !== "ok") {
      throw new BackupError(
        `backup_verify_failed: quick_check returned ${String(qc)}`,
        "backup_verify_failed",
        { quick_check: qc },
      );
    }
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version !== expectedUserVersion) {
      throw new BackupError(
        `backup_verify_failed: user_version ${version} != source ${expectedUserVersion}`,
        "backup_verify_failed",
        { user_version: version, expected: expectedUserVersion },
      );
    }
    if (existsSync(`${snapshotPath}-wal`) || existsSync(`${snapshotPath}-shm`)) {
      throw new BackupError(
        "backup_verify_failed: snapshot has WAL/SHM sidecars",
        "backup_verify_failed",
      );
    }
  } finally {
    db.close();
  }
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function writeUstarHeader(
  name: string,
  size: number,
  mode: number,
): Buffer {
  const buf = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > 100) {
    throw new Error(`tar member name too long: ${name}`);
  }
  nameBytes.copy(buf, 0);
  buf.write(mode.toString(8).padStart(7, "0"), 100, 7, "utf8");
  buf.write("0000000", 108, 7, "utf8");
  buf.write("0000000", 116, 7, "utf8");
  buf.write(size.toString(8).padStart(11, "0"), 124, 11, "utf8");
  buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0"), 136, 11, "utf8");
  buf.write("        ", 148, 8, "utf8");
  buf[156] = 0x30; // regular file
  Buffer.from("ustar\0", "utf8").copy(buf, 257);
  Buffer.from("00", "utf8").copy(buf, 263);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buf[i]!;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return buf;
}

async function writeTarGz(
  archivePath: string,
  members: Array<{ name: string; filePath: string; mode: number }>,
): Promise<void> {
  const partial = `${archivePath}.partial`;
  if (existsSync(partial)) rmSync(partial, { force: true });
  const gzip = createGzip();
  const out = createWriteStream(partial, { mode: 0o600 });
  const writing = pipeline(gzip, out);

  for (const member of members) {
    const data = readFileSync(member.filePath);
    gzip.write(writeUstarHeader(member.name, data.length, member.mode));
    gzip.write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) gzip.write(Buffer.alloc(pad, 0));
  }
  gzip.write(Buffer.alloc(1024, 0));
  gzip.end();
  await writing;
  chmodSync(partial, 0o600);
  renameSync(partial, archivePath);
  chmodSync(archivePath, 0o600);
}

export async function createBackup(
  options: CreateBackupOptions,
): Promise<BackupResult> {
  const homeDir = options.homeDir ?? globalStageflowHome();
  const dbOnly = options.dbOnly === true;
  const noCredentials = options.noCredentials === true;
  const includeA2a = options.includeA2aArtifacts === true;
  const now = options.now?.() ?? new Date();
  const createdAt = now.toISOString();

  const outPath = assertBackupOutPathAllowed(
    options.outPath ?? defaultBackupOutPath(homeDir, now, dbOnly),
    homeDir,
  );
  mkdirSync(path.dirname(outPath), { recursive: true });

  const freeReader = options.freeSpace ?? readFilesystemSize;
  const free = await freeReader(homeDir);
  const needed = stateDbTripletBytes(homeDir) + FREE_SPACE_MARGIN_BYTES;
  if (free.freeBytes < needed) {
    throw new BackupError(
      `backup_insufficient_disk: need ~${needed} bytes free, have ${free.freeBytes}`,
      "backup_insufficient_disk",
      { needed_bytes: needed, free_bytes: free.freeBytes },
    );
  }

  const settingsPath = path.join(homeDir, "settings.json");
  const authPath = path.join(homeDir, "agent", "auth.json");
  const settingsBefore = fingerprint(settingsPath);
  const authBefore = fingerprint(authPath);

  const staging = await mkdtemp(path.join(tmpdir(), "sf-backup-"));
  const snapshotPath = path.join(staging, "state.db");
  try {
    const { userVersion } = await options.store.snapshotInto(snapshotPath);
    verifyDbSnapshot(snapshotPath, userVersion);

    if (dbOnly) {
      const partial = `${outPath}.partial`;
      if (existsSync(partial)) rmSync(partial, { force: true });
      if (existsSync(outPath)) rmSync(outPath, { force: true });
      copyFileSync(snapshotPath, partial);
      chmodSync(partial, 0o600);
      try {
        renameSync(partial, outPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EXDEV") {
          throw new BackupError(
            "backup_cross_device: stage partial beside target on the same filesystem",
            "backup_cross_device",
          );
        }
        throw err;
      }
      chmodSync(outPath, 0o600);
      const bytes = statSync(outPath).size;
      return {
        path: outPath,
        bytes,
        sha256: sha256File(outPath),
        schema_version: userVersion,
        stageflow_version: PACKAGE_VERSION,
        created_at: createdAt,
        contents: ["state.db"],
      };
    }

    const settingsAfter = fingerprint(settingsPath);
    const authAfter = fingerprint(authPath);
    const fingerprintSkew =
      settingsBefore !== settingsAfter || authBefore !== authAfter;

    const contents: BackupContentsFlag[] = ["state.db", "manifest.json"];
    const members: Array<{ name: string; filePath: string; mode: number }> = [
      { name: "state.db", filePath: snapshotPath, mode: 0o600 },
    ];

    if (existsSync(settingsPath)) {
      const stagedSettings = path.join(staging, "settings.json");
      copyFileSync(settingsPath, stagedSettings);
      members.push({
        name: "settings.json",
        filePath: stagedSettings,
        mode: 0o600,
      });
      contents.push("settings.json");
    }

    if (!noCredentials && existsSync(authPath)) {
      const stagedAuth = path.join(staging, "auth.json");
      copyFileSync(authPath, stagedAuth);
      chmodSync(stagedAuth, 0o600);
      members.push({
        name: "agent/auth.json",
        filePath: stagedAuth,
        mode: 0o600,
      });
      contents.push("agent/auth.json");
    }

    if (includeA2a) {
      const a2aRoot = path.join(homeDir, "a2a-artifacts");
      if (existsSync(a2aRoot)) {
        contents.push("a2a-artifacts");
      }
    }

    const manifest: BackupManifest = {
      created_at: createdAt,
      stageflow_version: PACKAGE_VERSION,
      schema_version: userVersion,
      contents,
      db_only: false,
      credentials_included: !noCredentials && existsSync(authPath),
      a2a_artifacts_included: includeA2a,
      settings_fingerprint_before: settingsBefore,
      settings_fingerprint_after: settingsAfter,
      auth_fingerprint_before: authBefore,
      auth_fingerprint_after: authAfter,
      fingerprint_skew: fingerprintSkew,
      secret_warning: SECRET_WARNING,
    };
    const manifestPath = path.join(staging, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    members.push({
      name: "manifest.json",
      filePath: manifestPath,
      mode: 0o600,
    });

    if (existsSync(outPath)) rmSync(outPath, { force: true });
    await writeTarGz(outPath, members);

    const bytes = statSync(outPath).size;
    return {
      path: outPath,
      bytes,
      sha256: sha256File(outPath),
      schema_version: userVersion,
      stageflow_version: PACKAGE_VERSION,
      created_at: createdAt,
      contents,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function resolveBackupDownloadPath(
  name: string,
  homeDir: string = globalStageflowHome(),
): Promise<string> {
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    path.isAbsolute(name) ||
    name.endsWith(".partial")
  ) {
    throw new BackupError(
      "backup_out_denied: invalid backup name",
      "backup_out_denied",
    );
  }
  const root = backupsDir(homeDir);
  const candidate = path.resolve(root, name);
  const { classifyRealPathContainment } = await import("./workspaceLayout.js");
  const containment = await classifyRealPathContainment(candidate, root);
  if (containment.status === "missing") {
    throw new BackupError(
      `backup not found: ${name}`,
      "backup_out_denied",
    );
  }
  if (containment.status === "outside") {
    throw new BackupError(
      "backup_out_denied: path escapes backups directory",
      "backup_out_denied",
    );
  }
  return containment.realPath;
}

export function openBackupReadStream(filePath: string): ReturnType<
  typeof createReadStream
> {
  return createReadStream(filePath);
}
