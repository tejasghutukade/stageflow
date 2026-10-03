import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  type ProfileLock,
  type ProfileLockOptions,
  type ProfileLockOwner,
  type RunLiveness,
  lockKey,
  ownerMatches,
  sameOwner,
} from "./profileLock.js";
import type { ProfileKey } from "./profileStore.js";

function locksRoot(): string {
  return path.join(globalStageflowHome(), "browser", "locks");
}

function lockFile(key: ProfileKey): string {
  return path.join(locksRoot(), key.scope, `${key.name}.lock`);
}

async function readHolder(file: string): Promise<ProfileLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as ProfileLockOwner;
    if (typeof parsed.runId === "string" && typeof parsed.stageId === "string") {
      return { runId: parsed.runId, stageId: parsed.stageId };
    }
  } catch {
    // missing or unreadable: treated as free by callers that re-check
  }
  return undefined;
}

/** A lock file that exists but cannot be parsed (crash, disk full, manual edit). */
async function isCorrupt(file: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return false;
  }
  return readHolderFrom(raw) === undefined;
}

function readHolderFrom(raw: string): ProfileLockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as ProfileLockOwner;
    if (typeof parsed.runId === "string" && typeof parsed.stageId === "string") {
      return { runId: parsed.runId, stageId: parsed.stageId };
    }
  } catch {
    // unparseable
  }
  return undefined;
}

/** Removes a corrupt lock file via rename-away; restores it if it turned out valid. */
async function dropCorrupt(file: string): Promise<boolean> {
  const tomb = `${file}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(file, tomb);
  } catch {
    return true;
  }
  if ((await readHolder(tomb)) !== undefined) {
    await link(tomb, file).catch(() => undefined);
    await rm(tomb, { force: true });
    return false;
  }
  await rm(tomb, { force: true });
  return true;
}

/** `link` fails with EEXIST when the lock exists, and the content is complete at creation. */
async function createExclusive(
  file: string,
  owner: ProfileLockOwner,
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try {
    await link(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Removes a lock judged stale. The file is renamed away first and re-read, so
 * a lock another process re-created in the meantime is not dropped.
 */
async function dropStale(file: string, stale: ProfileLockOwner): Promise<boolean> {
  const tomb = `${file}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(file, tomb);
  } catch {
    return true;
  }
  const moved = await readHolder(tomb);
  if (moved !== undefined && !sameOwner(moved, stale)) {
    await link(tomb, file).catch(() => undefined);
    await rm(tomb, { force: true });
    return false;
  }
  await rm(tomb, { force: true });
  return true;
}

async function lockFiles(): Promise<string[]> {
  const files: string[] = [];
  let scopes: string[];
  try {
    scopes = await readdir(locksRoot());
  } catch {
    return files;
  }
  for (const scope of scopes) {
    let names: string[];
    try {
      names = await readdir(path.join(locksRoot(), scope));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".lock")) files.push(path.join(locksRoot(), scope, name));
    }
  }
  return files;
}

export function createLocalProfileLock(
  options: ProfileLockOptions = {},
): ProfileLock {
  // Serializes this process's operations per lock file; other processes rely on link/rename atomicity.
  const chains = new Map<string, Promise<unknown>>();
  const serialized = <T>(file: string, task: () => Promise<T>): Promise<T> => {
    const next = (chains.get(file) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task);
    chains.set(file, next);
    void next.finally(() => {
      if (chains.get(file) === next) chains.delete(file);
    });
    return next;
  };

  const releaseFile = (file: string, owner: ProfileLockOwner) =>
    serialized(file, async () => {
      const current = await readHolder(file);
      if (current !== undefined && sameOwner(current, owner)) {
        await rm(file, { force: true });
      }
    });

  return {
    async acquire(rawKey, owner) {
      const file = lockFile(lockKey(rawKey));
      return serialized(file, async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (await createExclusive(file, owner)) {
            return {
              status: "acquired" as const,
              release: () => releaseFile(file, owner),
            };
          }
          const current = await readHolder(file);
          if (current === undefined) {
            if (await isCorrupt(file)) await dropCorrupt(file);
            continue;
          }
          if (sameOwner(current, owner)) {
            return {
              status: "acquired" as const,
              release: () => releaseFile(file, owner),
            };
          }
          if (
            options.isRunLive !== undefined &&
            !(await options.isRunLive(current.runId))
          ) {
            if (await dropStale(file, current)) continue;
          }
          return { status: "queued" as const, holder: current };
        }
        const holder = await readHolder(file);
        return {
          status: "queued" as const,
          holder: holder ?? { runId: "unknown", stageId: "unknown" },
        };
      });
    },

    async holder(rawKey) {
      return readHolder(lockFile(lockKey(rawKey)));
    },

    async releaseOwner(target) {
      for (const file of await lockFiles()) {
        const current = await readHolder(file);
        if (current !== undefined && ownerMatches(current, target)) {
          await releaseFile(file, current);
        }
      }
    },

    async reclaimStale(isRunLive: RunLiveness) {
      let dropped = 0;
      for (const file of await lockFiles()) {
        const current = await readHolder(file);
        if (current === undefined) {
          if (await isCorrupt(file)) {
            if (await serialized(file, () => dropCorrupt(file))) dropped += 1;
          }
          continue;
        }
        if (await isRunLive(current.runId)) continue;
        if (await serialized(file, () => dropStale(file, current))) dropped += 1;
      }
      return dropped;
    },
  };
}
