import { mkdirSync } from "node:fs";
import type { RunStore } from "./port.js";
import { migrateLegacyStoreRoot, resolveStoreRoot } from "./paths.js";
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
 * Factory at the application edge. Call sites should receive the returned `RunStore`
 * and must not branch on backend kind.
 */
export function createRunStore(config: RunStoreConfig): RunStore {
  resolveKind(config.kind);
  migrateLegacyStoreRoot(config.rootDir);
  const storeRoot = resolveStoreRoot(config.rootDir);
  mkdirSync(storeRoot, { recursive: true });
  return new SqliteRunStore(storeRoot);
}

export type { RunStore };
