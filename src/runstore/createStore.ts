import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  assertStageflowHomeWritable,
  globalStageflowHome,
} from "../project/globalHome.js";
import type { EnsureGlobalServiceResult } from "../server/ensureGlobalService.js";
import type { RunStore } from "./port.js";
import {
  flattenNestedGlobalStore,
  isGlobalStageflowHome,
  migrateLegacyStoreRoot,
  resolveStoreRoot,
} from "./paths.js";
import { SqliteRunStore } from "./sqlite/SqliteRunStore.js";
import { CURRENT_SCHEMA_VERSION } from "./sqlite/migrations/index.js";
import { StoreSchemaError, type StoreSchemaErrorCode } from "./sqlite/storeSchemaError.js";

export type RunStoreKind = "sqlite";

export type RunStoreOpenerMode = "assert" | "migrate";

export type RunStoreConfig = {
  /** Project / factory root. Store data lives under `<rootDir>/.stageflow`. */
  rootDir: string;
  /** Defaults to `SF_STORE` env or `"sqlite"`. */
  kind?: RunStoreKind | "disk";
  /** Default `assert`; Host and tests that need a fresh schema pass `migrate`. */
  openerMode?: RunStoreOpenerMode;
};

export const DISK_STORE_REJECTED =
  "SF_STORE=disk is no longer a live RunStore. SQLite is the only adapter. Disk-era .stageflow/runs trees import automatically when the SQLite store is empty.";

function resolveKind(kind?: string): "sqlite" {
  const raw = kind ?? process.env.SF_STORE?.trim().toLowerCase();
  if (raw === "disk") {
    console.error(DISK_STORE_REJECTED);
    throw new Error(DISK_STORE_REJECTED);
  }
  return "sqlite";
}

function resolveOpenerMode(config: RunStoreConfig): RunStoreOpenerMode {
  if (config.openerMode !== undefined) {
    return config.openerMode;
  }
  if (process.env.VITEST === "true") {
    return "migrate";
  }
  return "assert";
}

export function storeNeedsHostMigration(rootDir: string): boolean {
  const storeRoot = resolveStoreRoot(rootDir);
  const dbPath = path.join(storeRoot, "state.db");
  if (!existsSync(dbPath)) {
    return true;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    return version < CURRENT_SCHEMA_VERSION;
  } finally {
    db.close();
  }
}

export async function createRunStoreAfterHostEnsure(
  config: RunStoreConfig,
  ensureService: () => Promise<EnsureGlobalServiceResult>,
): Promise<
  | { ok: true; store: RunStore }
  | {
      ok: false;
      message: string;
      reason?: "port_occupied" | "spawn_failed" | "timed_out" | "autostart_disabled";
      code?: StoreSchemaErrorCode;
    }
> {
  if (storeNeedsHostMigration(config.rootDir)) {
    const ensured = await ensureService();
    if (!ensured.ok) {
      return { ok: false, message: ensured.message, reason: ensured.reason };
    }
  }
  try {
    return {
      ok: true,
      store: createRunStore({ ...config, openerMode: "assert" }),
    };
  } catch (err) {
    if (err instanceof StoreSchemaError) {
      return { ok: false, message: err.message, code: err.code };
    }
    throw err;
  }
}

/**
 * Composition-root factory: hands back the concrete SQLite connection alongside the `RunStore`,
 * for the one caller wiring a second, colocated store (A2A's tables) into the same `state.db`
 * file. Ordinary call sites use `createRunStore` below and never see this.
 */
export function createRunStoreWithConnection(
  config: RunStoreConfig,
): { store: RunStore; connection: Database.Database } {
  resolveKind(config.kind);
  const globalHome = isGlobalStageflowHome(config.rootDir);
  if (globalHome) {
    assertStageflowHomeWritable();
    const home = globalStageflowHome();
    mkdirSync(home, { recursive: true });
    flattenNestedGlobalStore(home);
  } else {
    migrateLegacyStoreRoot(config.rootDir);
  }
  const storeRoot = resolveStoreRoot(config.rootDir);
  mkdirSync(storeRoot, { recursive: true });
  const openerMode = resolveOpenerMode(config);
  const store = new SqliteRunStore(storeRoot, { openerMode });
  return { store, connection: store.connection };
}

/**
 * Factory at the application edge. Call sites should receive the returned `RunStore`
 * and must not branch on backend kind.
 */
export function createRunStore(config: RunStoreConfig): RunStore {
  return createRunStoreWithConnection(config).store;
}

export type { RunStore };
