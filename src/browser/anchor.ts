import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BrowserEnv,
  type ProfileBrowser,
  type ProfileBrowserResult,
  type StageBrowserSupport,
} from "./browserHost.js";
import { defaultBrowserRunner, writeSessionOwner } from "./browserTeardown.js";
import type { ProfileHandle } from "./profileStore.js";
import type { StageBrowserConfig } from "../types/stage.js";

export const BROWSER_ANCHOR_FILENAME = "anchor.json";
const ANCHOR_LOCK_DIRNAME = "anchor.lock";
const LOCK_POLL_MS = 25;
const LOCK_WAIT_MS = 120_000;

export type PersistedAnchor = ProfileBrowser & {
  runId: string;
  profile: string;
  /** Bumped each time the anchor was replaced after the first start. */
  restarts: number;
};

export function anchorDir(runDir: string, profileName: string): string {
  return path.join(runDir, "browser", profileName);
}

export async function readPersistedAnchor(
  runDir: string,
  profileName: string,
): Promise<PersistedAnchor | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(anchorDir(runDir, profileName), BROWSER_ANCHOR_FILENAME), "utf8"),
    ) as Partial<PersistedAnchor>;
    if (
      typeof parsed.cdpAddress === "string" &&
      parsed.anchorEnv !== undefined &&
      typeof parsed.anchorEnv === "object"
    ) {
      return parsed as PersistedAnchor;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process mutex: atomic mkdir, stale when the recorded pid is gone. */
async function withFileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = path.join(dir, ANCHOR_LOCK_DIRNAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, "pid"), String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder = 0;
      try {
        holder = Number.parseInt(await readFile(path.join(lock, "pid"), "utf8"), 10);
      } catch {
        // holder is between mkdir and pid write
      }
      if (holder > 0 && holder !== process.pid && !pidAlive(holder)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for the shared browser lock");
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

const inflight = new Map<string, Promise<ProfileBrowserResult & { persisted: PersistedAnchor }>>();

/**
 * One shared browser per (run, profile). Concurrent callers in this process
 * share one promise; other processes serialize on a lock dir. The anchor and
 * its CDP address are persisted so stages, resume workers and the sweep reuse
 * them; a dead anchor is restarted and the address refreshed.
 */
export function ensureRunProfileBrowser(
  support: StageBrowserSupport,
  input: {
    runId: string;
    runDir: string;
    browser: StageBrowserConfig;
    profile: ProfileHandle;
    humanLogin?: boolean;
  },
): Promise<ProfileBrowserResult & { persisted: PersistedAnchor }> {
  const key = `${input.runDir}\0${input.profile.key.name}\0${input.humanLogin === true ? "h" : ""}`;
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  const promise = withFileLock(anchorDir(input.runDir, input.profile.key.name), async () => {
    const stored = await readPersistedAnchor(input.runDir, input.profile.key.name);
    const result = await support.host.ensureProfileBrowser({
      runId: input.runId,
      browser: input.browser,
      profile: input.profile,
      runner: support.runner ?? defaultBrowserRunner,
      ...(input.humanLogin === true ? { humanLogin: true } : {}),
      ...(stored !== undefined
        ? { previous: { cdpAddress: stored.cdpAddress, anchorEnv: stored.anchorEnv } }
        : {}),
    });
    const changed =
      stored === undefined ||
      stored.cdpAddress !== result.cdpAddress ||
      JSON.stringify(stored.anchorEnv) !== JSON.stringify(result.anchorEnv);
    const persisted: PersistedAnchor = {
      cdpAddress: result.cdpAddress,
      anchorEnv: result.anchorEnv,
      runId: input.runId,
      profile: input.profile.key.name,
      restarts: (stored?.restarts ?? 0) + (stored !== undefined && changed ? 1 : 0),
    };
    if (changed) {
      const dir = anchorDir(input.runDir, input.profile.key.name);
      const file = path.join(dir, BROWSER_ANCHOR_FILENAME);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
      await writeSessionOwner({
        runId: input.runId,
        stageId: `anchor:${input.profile.key.name}`,
        runDir: input.runDir,
        env: result.anchorEnv as BrowserEnv,
        anchor: true,
        profile: input.profile.key.name,
      }).catch(() => undefined);
    }
    return { ...result, restarted: stored !== undefined && changed, persisted };
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
