import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOST_LOCK_FILENAME = "host.lock";

/** How long a lock with no URL yet counts as a Host still booting. Older than this, it is stale. */
const BOOTING_GRACE_MS = 120_000;

type LockBody = { pid: number; hostname: string; startedAt: string; url?: string };

export class HostLockError extends Error {
  readonly code = "host_locked";
  constructor(
    readonly lockPath: string,
    readonly holder: LockBody,
  ) {
    super(
      `Another Stageflow Host is using this data directory (pid ${holder.pid}${holder.url ? `, ${holder.url}` : ", still starting"}). Stop it, or set STAGEFLOW_HOME to another directory.`,
    );
    this.name = "HostLockError";
  }
}

export type HostLock = {
  readonly path: string;
  /** Record where this Host listens, so a refused second start can name it. */
  setUrl(url: string): void;
  /** Remove the lock if this process still owns it. Safe to call more than once. */
  release(): void;
};

/** Hosts in this process share one lock per data directory (tests start several in-process). */
const held = new Map<string, { count: number; body: LockBody }>();

function readLock(lockPath: string): LockBody | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockBody>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    return {
      pid: parsed.pid,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
    };
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock is live when its process exists on this machine and, if it recorded a URL, still answers there with
 * Stageflow's /livez. A lock with no URL is live only while it is younger than the boot grace period. This keeps a
 * lock left by a crashed Host (or a reused pid after a container restart) from blocking the next start.
 */
async function lockIsLive(
  body: LockBody,
  probe: (url: string) => Promise<boolean>,
  now: number,
): Promise<boolean> {
  if (body.pid === process.pid) return false;
  if (body.hostname !== "" && body.hostname !== os.hostname()) {
    // Another machine or container wrote it; only a live URL proves it is still running.
    return body.url !== undefined && (await probe(body.url));
  }
  if (!pidAlive(body.pid)) return false;
  if (body.url !== undefined) return probe(body.url);
  const started = Date.parse(body.startedAt);
  return Number.isFinite(started) && now - started < BOOTING_GRACE_MS;
}

async function defaultProbe(url: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetch(`${url}/livez`, { signal: ac.signal });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { ok?: unknown; status?: unknown };
    return body.ok === true && body.status === "live";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function writeExclusive(lockPath: string, body: LockBody): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeFileSync(fd, JSON.stringify(body), "utf8");
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Take `$STAGEFLOW_HOME/host.lock` before a Host touches the store: one Host per data directory, whatever port or
 * address it binds. Throws HostLockError when a live Host holds it; replaces a stale lock.
 */
export async function acquireHostLock(
  home: string,
  options: { probe?: (url: string) => Promise<boolean>; now?: () => number } = {},
): Promise<HostLock> {
  const lockPath = path.join(path.resolve(home), HOST_LOCK_FILENAME);
  const probe = options.probe ?? defaultProbe;
  const now = options.now ?? Date.now;
  const existingHold = held.get(lockPath);
  if (existingHold !== undefined) {
    existingHold.count += 1;
    return handle(lockPath);
  }
  const body: LockBody = { pid: process.pid, hostname: os.hostname(), startedAt: new Date(now()).toISOString() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (writeExclusive(lockPath, body)) {
      held.set(lockPath, { count: 1, body });
      return handle(lockPath);
    }
    const current = readLock(lockPath);
    if (current !== undefined && (await lockIsLive(current, probe, now()))) {
      throw new HostLockError(lockPath, current);
    }
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const current = readLock(lockPath);
  throw new HostLockError(lockPath, current ?? body);
}

function handle(lockPath: string): HostLock {
  let released = false;
  return {
    path: lockPath,
    setUrl(url: string) {
      const hold = held.get(lockPath);
      if (hold === undefined || hold.body.url !== undefined) return;
      hold.body = { ...hold.body, url };
      const onDisk = readLock(lockPath);
      if (onDisk?.pid !== process.pid) return;
      writeFileSync(lockPath, JSON.stringify(hold.body), { encoding: "utf8", mode: 0o600 });
    },
    release() {
      if (released) return;
      released = true;
      const hold = held.get(lockPath);
      if (hold === undefined) return;
      hold.count -= 1;
      if (hold.count > 0) return;
      held.delete(lockPath);
      if (readLock(lockPath)?.pid !== process.pid) return;
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone
      }
    },
  };
}

/** Remove every lock this process holds. Called on process exit so a normal shutdown never leaves one behind. */
export function releaseAllHostLocksSync(): void {
  for (const [lockPath, hold] of held) {
    held.delete(lockPath);
    if (readLock(lockPath)?.pid !== process.pid) continue;
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
    void hold;
  }
}

let exitHookInstalled = false;
export function installHostLockExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", releaseAllHostLocksSync);
}

export function resetHostLocksForTests(): void {
  held.clear();
}
