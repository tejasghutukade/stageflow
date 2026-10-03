import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPersistedBrowserEnv } from "./persistedEnv.js";
import { stageDir } from "../runstore/paths.js";
import type { StageLogEvent } from "../runstore/port.js";
import { auditStageNavigations } from "./navigationAudit.js";
import {
  BROWSER_ENV_FILENAME,
  BROWSER_POLICY_FILENAME,
  type BrowserEnv,
  type BrowserRunner,
  type StageBrowserSupport,
} from "./browserHost.js";
import { stageProfileLock } from "./stageProfileLock.js";
import {
  BROWSER_ANCHOR_FILENAME,
  anchorDir,
  readPersistedAnchor,
} from "./anchor.js";

export const BROWSER_OWNER_FILENAME = "owner.json";
/** Written once a stage's tab and session are closed; cleared when its env is resolved again. */
export const BROWSER_CLOSED_FILENAME = "browser-closed.json";
const DEFAULT_CLOSE_WAIT_MS = 10_000;
const POLL_MS = 50;
const CLOSE_COMMAND_TIMEOUT_MS = 20_000;

export type BrowserSessionOwner = {
  runId: string;
  stageId: string;
  runDir: string;
  env: BrowserEnv;
  /** The run's shared browser for `profile`; stage sessions attach to it. */
  anchor?: true;
  profile?: string;
};

export const defaultBrowserRunner: BrowserRunner = (args, env, options) =>
  new Promise((resolve) => {
    execFile(
      "agent-browser",
      args,
      {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
        timeout: options?.timeoutMs ?? CLOSE_COMMAND_TIMEOUT_MS,
      },
      (err, stdout) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        resolve({
          code: err ? (typeof code === "number" ? code : 1) : 0,
          stdout: String(stdout ?? ""),
        });
      },
    );
  });

export async function writeSessionOwner(
  owner: BrowserSessionOwner,
): Promise<void> {
  const dir = owner.env.AGENT_BROWSER_SOCKET_DIR;
  if (!dir) return;
  await writeFile(
    path.join(dir, BROWSER_OWNER_FILENAME),
    `${JSON.stringify(owner)}\n`,
    { mode: 0o600 },
  );
}

function pidAlive(pidFile: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function daemonGone(dir: string, session: string): boolean {
  if (existsSync(path.join(dir, `${session}.sock`))) return false;
  const pidFile = path.join(dir, `${session}.pid`);
  return !existsSync(pidFile) || !pidAlive(pidFile);
}

async function removeSessionFiles(dir: string, session: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${session}.`) || name === BROWSER_OWNER_FILENAME) {
      await rm(path.join(dir, name), { force: true });
    }
  }
  await rmdir(dir).catch(() => undefined);
  await rmdir(path.dirname(dir)).catch(() => undefined);
}

/**
 * Gracefully closes the session with the exact env it was launched with, waits
 * (bounded) for the daemon to disappear, then removes the leftover socket-dir
 * files. Never signals Chrome: a hard kill loses cookie persistence.
 */
export async function closeBrowserSession(
  env: BrowserEnv,
  options: { runner?: BrowserRunner; closeWaitMs?: number } = {},
): Promise<{ gone: boolean }> {
  const runner = options.runner ?? defaultBrowserRunner;
  try {
    await runner(["close"], env);
  } catch {
    // close of an already-gone session is not an error
  }
  const dir = env.AGENT_BROWSER_SOCKET_DIR;
  const session = env.AGENT_BROWSER_SESSION;
  if (!dir || !session) return { gone: true };

  const deadline = Date.now() + (options.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS);
  while (!daemonGone(dir, session)) {
    if (Date.now() >= deadline) return { gone: false };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await removeSessionFiles(dir, session);
  return { gone: true };
}

async function readEnvFile(file: string): Promise<BrowserEnv | undefined> {
  try {
    return await readPersistedBrowserEnv(file);
  } catch {
    return undefined;
  }
}

function closeOptions(support: StageBrowserSupport) {
  return {
    ...(support.runner !== undefined ? { runner: support.runner } : {}),
    ...(support.closeWaitMs !== undefined
      ? { closeWaitMs: support.closeWaitMs }
      : {}),
  };
}

/**
 * Closes one stage's tab (when it is attached to a shared browser) and then
 * its session. Chrome, the lease and the other stages stay up. No-op for
 * stages that never resolved a browser env.
 */
export function teardownStageBrowser(
  support: StageBrowserSupport,
  input: { runId: string; runDir: string; stageId: string },
): Promise<void> {
  const key = `${input.runDir}\0${input.stageId}`;
  const running = stageTeardowns.get(key);
  if (running !== undefined) return running;
  const promise = teardownStageBrowserOnce(support, input).finally(() => {
    stageTeardowns.delete(key);
  });
  stageTeardowns.set(key, promise);
  return promise;
}

const stageTeardowns = new Map<string, Promise<void>>();

async function teardownStageBrowserOnce(
  support: StageBrowserSupport,
  input: { runId: string; runDir: string; stageId: string },
): Promise<void> {
  const env = await readEnvFile(
    path.join(stageDir(input.runDir, input.stageId), BROWSER_ENV_FILENAME),
  );
  if (env === undefined) return;
  const closedMarker = path.join(
    stageDir(input.runDir, input.stageId),
    BROWSER_CLOSED_FILENAME,
  );
  // A second close would re-attach to the shared browser and could close another stage's tab.
  if (existsSync(closedMarker)) return;
  if (env.AGENT_BROWSER_CDP !== undefined) {
    // With the pinned tab as the current tab, `tab close` closes only this stage's tab.
    await (support.runner ?? defaultBrowserRunner)(["tab", "close"], env).catch(
      () => undefined,
    );
  }
  const { gone } = await closeBrowserSession(env, closeOptions(support));
  if (gone) await writeFile(closedMarker, "{}\n").catch(() => undefined);
}

/** Gracefully closes every anchor browser the run started. */
export function closeRunAnchors(
  support: StageBrowserSupport,
  run: { runDir: string },
): Promise<void> {
  const running = anchorTeardowns.get(run.runDir);
  if (running !== undefined) return running;
  const promise = closeRunAnchorsOnce(support, run).finally(() => {
    anchorTeardowns.delete(run.runDir);
  });
  anchorTeardowns.set(run.runDir, promise);
  return promise;
}

const anchorTeardowns = new Map<string, Promise<void>>();

async function closeRunAnchorsOnce(
  support: StageBrowserSupport,
  run: { runDir: string },
): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(path.join(run.runDir, "browser"));
  } catch {
    return;
  }
  for (const name of names) {
    const anchor = await readPersistedAnchor(run.runDir, name);
    if (anchor === undefined) continue;
    const { gone } = await closeBrowserSession(
      anchor.anchorEnv,
      closeOptions(support),
    ).catch(() => ({ gone: false }));
    if (gone) {
      await rm(path.join(anchorDir(run.runDir, name), BROWSER_ANCHOR_FILENAME), {
        force: true,
      }).catch(() => undefined);
    }
  }
}

/**
 * Run end, cancel, abandon or failure: closes stage sessions and tabs, then
 * the run's anchors, then releases the run's profile leases. `only` closes
 * just those stages and leaves anchor and leases alone.
 */
export async function teardownRunBrowsers(
  support: StageBrowserSupport,
  run: { runId: string; runDir: string },
  only?: (stageId: string) => boolean,
): Promise<void> {
  let ids: string[] = [];
  try {
    ids = await readdir(path.join(run.runDir, "stages"));
  } catch {
    // no stage dirs: nothing to close
  }
  for (const stageId of ids) {
    if (only !== undefined && !only(stageId)) continue;
    await teardownStageBrowser(support, { ...run, stageId }).catch(
      () => undefined,
    );
  }
  if (only === undefined) {
    await closeRunAnchors(support, run).catch(() => undefined);
    await stageProfileLock(support)
      .releaseOwner({ runId: run.runId })
      .catch(() => undefined);
  }
}
