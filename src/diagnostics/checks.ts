import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createOwnerOnlyDirectory, globalStageflowHome } from "../project/globalHome.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import type { RunStore } from "../runstore/port.js";

const execFileAsync = promisify(execFile);

export type DiagnosticSeverity = "error" | "warn" | "skipped";

export type DiagnosticCheckResult = {
  id: string;
  ok: boolean;
  severity: DiagnosticSeverity;
  message: string;
  code?: string;
  detail?: Record<string, unknown>;
};

export type ReadyzChecks = {
  store_openable: boolean;
  home_writable: boolean;
  migrations_complete: boolean;
  git_present: boolean;
};

export type ReadyzResult = {
  ready: boolean;
  checks: ReadyzChecks;
  code?: string;
};

const READYZ_TTL_MS = 4_000;

let readyzCache:
  | { expiresAt: number; result: ReadyzResult }
  | undefined;

export function resetReadyzCacheForTests(): void {
  readyzCache = undefined;
}

const HOST_ID_FILENAME = "host-id";
const HOST_ID_PATTERN = /^[0-9a-f]{16}$/;
const homeIds = new Map<string, string>();

export function resetStageflowHomeIdsForTests(): void {
  homeIds.clear();
}

function readHostId(filePath: string): string | undefined {
  try {
    const text = readFileSync(filePath, "utf8").trim();
    return HOST_ID_PATTERN.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A random id stored once in `<home>/host-id`. The CLI and the Host read the same file, so they agree on
 * whether a running Host uses this data directory. `/livez` is unauthenticated: the id reveals neither the
 * path nor the user name.
 */
export function stageflowHomeId(home: string = globalStageflowHome()): string {
  const resolved = path.resolve(home);
  const cached = homeIds.get(resolved);
  if (cached !== undefined) return cached;
  const filePath = path.join(resolved, HOST_ID_FILENAME);
  let id = readHostId(filePath);
  if (id === undefined) {
    createOwnerOnlyDirectory(resolved);
    const minted = randomBytes(8).toString("hex");
    try {
      const fd = openSync(filePath, "wx", 0o600);
      try {
        writeFileSync(fd, minted, "utf8");
      } finally {
        closeSync(fd);
      }
      id = minted;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      id = readHostId(filePath) ?? minted;
    }
  }
  homeIds.set(resolved, id);
  return id;
}

/**
 * The data directory's id if a Host has ever written one, without creating it. CLI callers use this, so a probe
 * never creates files in a data directory no Host uses.
 */
export function readStageflowHomeId(home: string = globalStageflowHome()): string | undefined {
  const resolved = path.resolve(home);
  return homeIds.get(resolved) ?? readHostId(path.join(resolved, HOST_ID_FILENAME));
}

export function livezBody(): {
  ok: true;
  status: "live";
  service: "stageflow";
  version: string;
  home_id: string;
} {
  return {
    ok: true,
    status: "live",
    service: "stageflow",
    version: PACKAGE_VERSION,
    home_id: stageflowHomeId(),
  };
}

async function checkGitPresent(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function probeGitVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function checkHomeWritable(home: string): boolean {
  try {
    accessSync(home, constants.W_OK);
    const probe = `${home}/.stageflow-write-probe-${process.pid}`;
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function checkStoreOpenable(store: RunStore): Promise<boolean> {
  try {
    await store.listRuns({ origin: "any" });
    return true;
  } catch {
    return false;
  }
}

function checkMigrationsComplete(store: RunStore): boolean {
  const connection = (store as { connection?: { pragma?: (q: string, opts?: { simple?: boolean }) => unknown } }).connection;
  if (connection === undefined || typeof connection.pragma !== "function") {
    return true;
  }
  try {
    const version = connection.pragma("user_version", { simple: true });
    return typeof version === "number" && version >= 0;
  } catch {
    return false;
  }
}

export async function runReadyzChecks(options: {
  store: RunStore;
  homeDir?: string;
  now?: number;
  bypassCache?: boolean;
}): Promise<ReadyzResult> {
  const now = options.now ?? Date.now();
  if (
    !options.bypassCache &&
    readyzCache !== undefined &&
    readyzCache.expiresAt > now
  ) {
    return readyzCache.result;
  }

  const home = options.homeDir ?? globalStageflowHome();
  const checks: ReadyzChecks = {
    store_openable: await checkStoreOpenable(options.store),
    home_writable: checkHomeWritable(home),
    migrations_complete: checkMigrationsComplete(options.store),
    git_present: await checkGitPresent(),
  };

  let code: string | undefined;
  if (!checks.store_openable) code = "store_not_openable";
  else if (!checks.home_writable) code = "home_not_writable";
  else if (!checks.migrations_complete) code = "migrations_incomplete";
  else if (!checks.git_present) code = "git_not_present";

  const result: ReadyzResult = {
    ready: code === undefined,
    checks,
    ...(code !== undefined ? { code } : {}),
  };
  readyzCache = { expiresAt: now + READYZ_TTL_MS, result };
  return result;
}

export type SchemaHealthStub = {
  user_version: number | null;
  schema_migrations: "present" | "absent" | "unknown";
  note?: string;
};

export function readSchemaHealth(store: RunStore): SchemaHealthStub {
  const connection = (store as { connection?: { pragma?: (q: string, opts?: { simple?: boolean }) => unknown; prepare?: (sql: string) => { get: () => unknown } } }).connection;
  if (connection === undefined || typeof connection.pragma !== "function") {
    return {
      user_version: null,
      schema_migrations: "unknown",
      note: "Slot 1 schema reporting stub — store has no sqlite connection",
    };
  }
  try {
    const user_version = connection.pragma("user_version", {
      simple: true,
    }) as number;
    let schema_migrations: SchemaHealthStub["schema_migrations"] = "unknown";
    if (typeof connection.prepare === "function") {
      try {
        connection.prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
        ).get();
        schema_migrations = "present";
      } catch {
        schema_migrations = "absent";
      }
    }
    return { user_version, schema_migrations };
  } catch {
    return {
      user_version: null,
      schema_migrations: "unknown",
      note: "Slot 1 schema reporting stub — pragma failed",
    };
  }
}
