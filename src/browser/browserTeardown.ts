import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

export const BROWSER_OWNER_FILENAME = "owner.json";
const DEFAULT_CLOSE_WAIT_MS = 10_000;
const POLL_MS = 50;
const CLOSE_COMMAND_TIMEOUT_MS = 20_000;

export type BrowserSessionOwner = {
  runId: string;
  stageId: string;
  runDir: string;
  env: BrowserEnv;
};

export const defaultBrowserRunner: BrowserRunner = (args, env) =>
  new Promise((resolve) => {
    execFile(
      "agent-browser",
      args,
      {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
        timeout: CLOSE_COMMAND_TIMEOUT_MS,
      },
      (err) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        resolve({ code: err ? (typeof code === "number" ? code : 1) : 0 });
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
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as BrowserEnv;
    }
  } catch {
    // no browser env persisted: not a browser stage
  }
  return undefined;
}

/** No-op for stages that never resolved a browser env. */
export async function teardownStageBrowser(
  support: StageBrowserSupport,
  input: { runId: string; runDir: string; stageId: string },
): Promise<void> {
  const env = await readEnvFile(
    path.join(stageDir(input.runDir, input.stageId), BROWSER_ENV_FILENAME),
  );
  try {
    if (env === undefined) return;
    await closeBrowserSession(env, {
      ...(support.runner !== undefined ? { runner: support.runner } : {}),
      ...(support.closeWaitMs !== undefined
        ? { closeWaitMs: support.closeWaitMs }
        : {}),
    });
  } finally {
    await stageProfileLock(support)
      .releaseOwner({ runId: input.runId, stageId: input.stageId })
      .catch(() => undefined);
  }
}

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
    await stageProfileLock(support)
      .releaseOwner({ runId: run.runId })
      .catch(() => undefined);
  }
}
