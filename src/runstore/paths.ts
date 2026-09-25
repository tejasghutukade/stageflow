import { randomBytes } from "node:crypto";
import {
  existsSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { globalStageflowHome } from "../project/globalHome.js";
import { guardStageId } from "./workspaceLayout.js";

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Root for factory state under a project: `<rootDir>/.stageflow`. */
export function storeRootFor(rootDir: string): string {
  return path.join(rootDir, ".stageflow");
}

export function isGlobalStageflowHome(rootDir: string): boolean {
  return path.resolve(rootDir) === globalStageflowHome();
}

/** Project store root or the durable home when `rootDir` is the global home. */
export function resolveStoreRoot(rootDir: string): string {
  if (isGlobalStageflowHome(rootDir)) {
    return globalStageflowHome();
  }
  return storeRootFor(rootDir);
}

const NESTED_GLOBAL_STORE_DIR = ".stageflow";
const STATE_DB_BASENAME = "state.db";
const STATE_DB_SIDECARS = ["state.db-wal", "state.db-shm"] as const;
const NESTED_STORE_MOVE_DIRS = ["runs", "a2a-artifacts"] as const;

export const NESTED_GLOBAL_STORE_CONFLICT =
  "Cannot open the global store: flat state.db has no runs table while nested .stageflow/state.db still holds run data. Resolve the conflict manually.";

function sqliteHasRunsTable(dbPath: string): boolean {
  if (!existsSync(dbPath)) {
    return false;
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
      )
      .get() as { name: string } | undefined;
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function assertNoNestedGlobalStoreConflict(home: string): void {
  const flatDb = path.join(home, STATE_DB_BASENAME);
  const nestedDb = path.join(home, NESTED_GLOBAL_STORE_DIR, STATE_DB_BASENAME);
  if (!existsSync(flatDb) || !existsSync(nestedDb)) {
    return;
  }
  if (!sqliteHasRunsTable(flatDb) && sqliteHasRunsTable(nestedDb)) {
    throw new Error(NESTED_GLOBAL_STORE_CONFLICT);
  }
}

function renameIfExists(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) {
    return;
  }
  renameSync(from, to);
}

function rollbackStateDbSet(home: string, nested: string, moved: string[]): void {
  for (const name of [...moved].reverse()) {
    const from = path.join(home, name);
    const to = path.join(nested, name);
    if (existsSync(from) && !existsSync(to)) {
      renameSync(from, to);
    }
  }
}

function moveStateDbSet(home: string, nested: string): void {
  const flatMain = path.join(home, STATE_DB_BASENAME);
  const nestedMain = path.join(nested, STATE_DB_BASENAME);
  const flatHasMain = existsSync(flatMain);
  const nestedHasMain = existsSync(nestedMain);

  if (flatHasMain && nestedHasMain) {
    return;
  }

  if (flatHasMain && !nestedHasMain) {
    for (const sidecar of STATE_DB_SIDECARS) {
      renameIfExists(path.join(nested, sidecar), path.join(home, sidecar));
    }
    return;
  }

  if (!flatHasMain && nestedHasMain) {
    const names = [STATE_DB_BASENAME, ...STATE_DB_SIDECARS];
    const moved: string[] = [];
    try {
      for (const name of names) {
        const from = path.join(nested, name);
        const to = path.join(home, name);
        if (existsSync(from) && !existsSync(to)) {
          renameSync(from, to);
          moved.push(name);
        }
      }
    } catch (err) {
      rollbackStateDbSet(home, nested, moved);
      throw err;
    }
  }
}

function flatStorePathAbsent(home: string, name: string): boolean {
  const target = path.join(home, name);
  const state = directoryState(target);
  return state === "missing";
}

function moveNestedStoreDirs(home: string, nested: string): void {
  for (const dirName of NESTED_STORE_MOVE_DIRS) {
    const from = path.join(nested, dirName);
    const to = path.join(home, dirName);
    if (directoryState(from) === "missing") {
      continue;
    }
    if (!flatStorePathAbsent(home, dirName)) {
      continue;
    }
    renameSync(from, to);
  }
}

function removeNestedGlobalStoreDirIfEmpty(home: string): void {
  const nested = path.join(home, NESTED_GLOBAL_STORE_DIR);
  const state = directoryState(nested);
  if (state === "missing" || state === "other") {
    return;
  }
  const inventory = [
    STATE_DB_BASENAME,
    ...STATE_DB_SIDECARS,
    ...NESTED_STORE_MOVE_DIRS,
  ];
  for (const name of inventory) {
    if (existsSync(path.join(nested, name))) {
      return;
    }
  }
  if (state === "empty") {
    rmdirSync(nested);
  }
}

export function flattenNestedGlobalStore(home: string): void {
  const nested = path.join(home, NESTED_GLOBAL_STORE_DIR);
  const nestedState = directoryState(nested);
  if (nestedState === "missing" || nestedState === "other") {
    assertNoNestedGlobalStoreConflict(home);
    return;
  }
  assertNoNestedGlobalStoreConflict(home);
  moveStateDbSet(home, nested);
  moveNestedStoreDirs(home, nested);
  removeNestedGlobalStoreDirIfEmpty(home);
}

function directoryState(
  dirPath: string,
): "missing" | "empty" | "populated" | "other" {
  try {
    const st = statSync(dirPath);
    if (!st.isDirectory()) return "other";
    return readdirSync(dirPath).length === 0 ? "empty" : "populated";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

export function migrateLegacyStoreRoot(rootDir: string): void {
  const newPath = storeRootFor(rootDir);
  const oldPath = path.join(rootDir, ".software-factory");
  const newState = directoryState(newPath);
  if (newState === "populated") {
    return;
  }
  const oldState = directoryState(oldPath);
  if (oldState !== "empty" && oldState !== "populated") {
    return;
  }
  if (newState === "empty") {
    rmdirSync(newPath);
  }
  try {
    renameSync(oldPath, newPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" &&
      directoryState(oldPath) === "missing" &&
      directoryState(newPath) === "populated"
    ) {
      return;
    }
    throw err;
  }
}

export function runsDir(storeRoot: string): string {
  return path.join(storeRoot, "runs");
}

export function runWorkspaceDir(storeRoot: string, runId: string): string {
  return path.join(runsDir(storeRoot), runId);
}

export function stageDir(workspaceDir: string, stageId: string): string {
  guardStageId(stageId);
  return path.join(workspaceDir, "stages", stageId);
}
