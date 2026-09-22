import { mkdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  assertStageflowHomeWritable,
  globalStageflowHome,
} from "../project/globalHome.js";
import type { RunStore } from "./port.js";
import {
  flattenNestedGlobalStore,
  isGlobalStageflowHome,
  migrateLegacyStoreRoot,
  resolveStoreRoot,
} from "./paths.js";
import { SqliteRunStore } from "./sqlite/SqliteRunStore.js";

export type RunStoreKind = "sqlite";

export type RunStoreConfig = {
  /** Project / factory root. Store data lives under `<rootDir>/.stageflow`. */
  rootDir: string;
  /** Defaults to `SF_STORE` env or `"sqlite"`. */
  kind?: RunStoreKind | "disk";
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

/**
 * Composition-root factory: hands back the concrete SQLite connection alongside the `RunStore`,
 * for the one caller wiring a second, colocated store (A2A's tables) into the same `state.db`
 * file. Ordinary call sites use `createRunStore` below and never see this.
 */
export function createRunStoreWithConnection(config: RunStoreConfig): { store: RunStore; connection: Database.Database } {
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
  const store = new SqliteRunStore(storeRoot);
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
