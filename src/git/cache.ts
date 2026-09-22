import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ensureGlobalHome, globalStageflowHome } from "../project/globalHome.js";
import { hostGitAskpassEnv } from "./credentials.js";
import { catFileCommit, cloneBare, remoteUpdate } from "./operations.js";

const FETCH_TIMEOUT_MS = 300_000;
const LOCK_POLL_MS = 50;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

type MutexTail = Promise<unknown>;

const mutexTails = new Map<string, MutexTail>();

let remoteUrlOverride: ((repository: string) => string | undefined) | null = null;

export function setBareCacheRemoteUrlOverrideForTests(
  override: ((repository: string) => string | undefined) | null,
): void {
  remoteUrlOverride = override;
}

export function resetBareCacheStateForTests(): void {
  mutexTails.clear();
  remoteUrlOverride = null;
}

export function githubHttpsRemoteUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

export function bareCachePath(repository: string): string {
  const [owner, repo] = repository.split("/");
  return path.join(globalStageflowHome(), "repos", "github.com", owner, `${repo}.git`);
}

export function remoteUrlForRepository(repository: string): string {
  const overridden = remoteUrlOverride?.(repository);
  if (overridden) return overridden;
  return githubHttpsRemoteUrl(repository);
}

function isFullCommitSha(ref: string): boolean {
  return FULL_SHA_RE.test(ref);
}

function isFileUrl(url: string): boolean {
  return url.startsWith("file:");
}

function fetchLockPath(cachePath: string): string {
  if (existsSync(cachePath)) {
    return path.join(cachePath, ".stageflow-fetch.lock");
  }
  return `${cachePath}.stageflow-fetch.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withInProcessMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  mutexTails.set(key, tail);

  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (mutexTails.get(key) === tail) {
      mutexTails.delete(key);
    }
  }
}

function tryReclaimStaleLock(lockPath: string, staleMs: number): void {
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs > staleMs) {
      unlinkSync(lockPath);
    }
  } catch {
    // gone or unreadable
  }
}

async function acquireExclusiveLock(lockPath: string, staleMs: number): Promise<number> {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(
        fd,
        `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
        0,
        "utf8",
      );
      return fd;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;
      tryReclaimStaleLock(lockPath, staleMs);
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseExclusiveLock(fd: number, lockPath: string): void {
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

async function withExclusiveLock<T>(
  lockPath: string,
  staleMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const fd = await acquireExclusiveLock(lockPath, staleMs);
  try {
    return await fn();
  } finally {
    releaseExclusiveLock(fd, lockPath);
  }
}

export type EnsureBareCacheResult = {
  cachePath: string;
  fetched: boolean;
};

export type EnsureBareCacheOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export async function ensureBareCache(
  repository: string,
  ref: string,
  options?: EnsureBareCacheOptions,
): Promise<EnsureBareCacheResult> {
  ensureGlobalHome();
  const cachePath = bareCachePath(repository);
  const url = remoteUrlForRepository(repository);
  const requireToken = !isFileUrl(url);

  return withInProcessMutex(cachePath, async () => {
    if (isFullCommitSha(ref) && existsSync(cachePath)) {
      const present = await catFileCommit(cachePath, ref, {
        env: options?.env,
        signal: options?.signal,
      });
      if (present) {
        return { cachePath, fetched: false };
      }
    }

    const lockPath = fetchLockPath(cachePath);
    return withExclusiveLock(lockPath, FETCH_TIMEOUT_MS, async () => {
      if (isFullCommitSha(ref) && existsSync(cachePath)) {
        const present = await catFileCommit(cachePath, ref, {
          env: options?.env,
          signal: options?.signal,
        });
        if (present) {
          return { cachePath, fetched: false };
        }
      }

      const askpassEnv = hostGitAskpassEnv({
        env: options?.env,
        requireToken,
      });
      const gitEnv = { ...askpassEnv, ...options?.env };
      const callOpts = { env: gitEnv, signal: options?.signal };

      mkdirSync(path.dirname(cachePath), { recursive: true });

      if (!existsSync(cachePath)) {
        await cloneBare(url, cachePath, callOpts);
        return { cachePath, fetched: true };
      }

      await remoteUpdate(cachePath, callOpts);
      return { cachePath, fetched: true };
    });
  });
}
