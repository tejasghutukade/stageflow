import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { StoreOpenError } from "./storeOpenError.js";

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 1000;
/** Residual WAL size that triggers a crash-path checkpoint attempt at Host boot. */
export const CRASH_WAL_CHECKPOINT_THRESHOLD_BYTES = 64 * 1024 * 1024;

const ALLOWED_SYNCHRONOUS = new Set(["OFF", "NORMAL", "FULL", "EXTRA"]);

export function readSqliteBusyTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STAGEFLOW_SQLITE_BUSY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  }
  return parsed;
}

export function readSqliteSynchronous(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.STAGEFLOW_SQLITE_SYNCHRONOUS?.trim().toUpperCase();
  if (raw === undefined || raw === "") return "FULL";
  if (!ALLOWED_SYNCHRONOUS.has(raw)) return "FULL";
  return raw;
}

export function readWalAutocheckpointPages(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STAGEFLOW_SQLITE_WAL_AUTOCHECKPOINT;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_WAL_AUTOCHECKPOINT_PAGES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_WAL_AUTOCHECKPOINT_PAGES;
  }
  return parsed;
}

/**
 * Apply durability and coordination pragmas on every store open (Host and workers).
 * Does not run quick_check or crash-path WAL handling — those are Host-boot only.
 */
export function applyStorePragmas(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): void {
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${readSqliteBusyTimeoutMs(env)}`);
  db.pragma("foreign_keys = ON");
  db.pragma(`synchronous = ${readSqliteSynchronous(env)}`);
  db.pragma(`wal_autocheckpoint = ${readWalAutocheckpointPages(env)}`);
}

export function assertStoreQuickCheck(db: Database.Database): void {
  let result: unknown;
  try {
    result = db.pragma("quick_check", { simple: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StoreOpenError(
      `store_integrity_failed: ${message}. Refuse to serve; restore with sf restore.`,
      "store_integrity_failed",
      { cause: message },
    );
  }
  if (result !== "ok") {
    throw new StoreOpenError(
      `store_integrity_failed: quick_check returned ${String(result)}. Refuse to serve; restore with sf restore.`,
      "store_integrity_failed",
      { quick_check: result },
    );
  }
}

export function isSqliteCorruptError(err: unknown): boolean {
  if (err instanceof StoreOpenError && err.code === "store_integrity_failed") {
    return true;
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /malformed|corrupt|file is not a database/i.test(message);
}

export function rethrowAsStoreIntegrityFailed(err: unknown): never {
  if (err instanceof StoreOpenError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new StoreOpenError(
    `store_integrity_failed: ${message}. Refuse to serve; restore with sf restore.`,
    "store_integrity_failed",
    { cause: message },
  );
}

export type CrashWalCheckpointResult = {
  attempted: boolean;
  walBytes: number;
  busy: boolean;
  completed: boolean;
};

/**
 * Crash-path residual WAL: if the sidecar exceeds the threshold, attempt
 * wal_checkpoint(TRUNCATE). Slot 4 owns clean-close checkpoint in close().
 */
export function maybeCheckpointResidualWal(
  storeRoot: string,
  db: Database.Database,
  options?: {
    thresholdBytes?: number;
    log?: (message: string, fields?: Record<string, unknown>) => void;
  },
): CrashWalCheckpointResult {
  const threshold =
    options?.thresholdBytes ?? CRASH_WAL_CHECKPOINT_THRESHOLD_BYTES;
  const walPath = path.join(storeRoot, "state.db-wal");
  if (!existsSync(walPath)) {
    return { attempted: false, walBytes: 0, busy: false, completed: false };
  }
  let walBytes = 0;
  try {
    walBytes = statSync(walPath).size;
  } catch {
    return { attempted: false, walBytes: 0, busy: false, completed: false };
  }
  if (walBytes <= threshold) {
    return { attempted: false, walBytes, busy: false, completed: false };
  }

  const log = options?.log;
  log?.("store.crash_wal.checkpoint_start", {
    wal_bytes: walBytes,
    threshold_bytes: threshold,
  });

  try {
    const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = rows[0];
    const busy = (row?.busy ?? 0) !== 0;
    if (busy) {
      log?.("store.crash_wal.checkpoint_busy", {
        wal_bytes: walBytes,
        note: "concurrent holder; checkpoint incomplete",
      });
      return { attempted: true, walBytes, busy: true, completed: false };
    }
    log?.("store.crash_wal.checkpoint_done", {
      wal_bytes: walBytes,
      checkpointed: row?.checkpointed,
    });
    return { attempted: true, walBytes, busy: false, completed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const busy = /SQLITE_BUSY|database is locked/i.test(message);
    log?.("store.crash_wal.checkpoint_failed", {
      wal_bytes: walBytes,
      busy,
      error: message,
    });
    return { attempted: true, walBytes, busy, completed: false };
  }
}
