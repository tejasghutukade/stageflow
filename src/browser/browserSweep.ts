import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  BROWSER_OWNER_FILENAME,
  type BrowserSessionOwner,
  closeBrowserSession,
} from "./browserTeardown.js";
import type { BrowserHost, BrowserRunner } from "./browserHost.js";
import { defaultSocketRoot } from "./localBrowserHost.js";
import { rmdir } from "node:fs/promises";

export type BrowserSweepOptions = {
  isRunLive: (runId: string) => Promise<boolean>;
  socketRoot?: string;
  runner?: BrowserRunner;
  closeWaitMs?: number;
  /** A host whose browsers live outside the local sockets sweeps them itself (containers, by label). */
  host?: BrowserHost;
};

async function readOwner(
  dir: string,
): Promise<BrowserSessionOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(dir, BROWSER_OWNER_FILENAME), "utf8"),
    ) as BrowserSessionOwner;
    if (typeof parsed.runId === "string" && parsed.env?.AGENT_BROWSER_SESSION) {
      return parsed;
    }
  } catch {
    // unreadable owner: treated as ownerless below
  }
  return undefined;
}

/**
 * At Host start: close sessions whose run is gone or terminal, clean leftover
 * files, and leave sessions of live or waiting runs alone.
 */
export async function sweepOrphanBrowserSessions(
  options: BrowserSweepOptions,
): Promise<{ closed: string[]; released: string[] }> {
  const { closed } = await sweepLocalSessions(options);
  // Stage sessions are closed first; the host then releases the browsers they were attached to.
  const swept = await (options.host?.sweepOrphans?.({ isRunLive: options.isRunLive }) ?? Promise.resolve({ released: [] }))
    .catch(() => ({ released: [] as string[] }));
  return { closed, released: swept.released };
}

async function sweepLocalSessions(
  options: BrowserSweepOptions,
): Promise<{ closed: string[] }> {
  const root = options.socketRoot ?? defaultSocketRoot(process.platform);
  const closed: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return { closed };
  }
  const owners: BrowserSessionOwner[] = [];
  for (const name of dirs) {
    const owner = await readOwner(path.join(root, name));
    if (owner !== undefined) owners.push(owner);
  }
  // Stage sessions attach to the anchor, so they go first.
  owners.sort((x, y) => Number(x.anchor === true) - Number(y.anchor === true));
  for (const owner of owners) {
    if (await options.isRunLive(owner.runId).catch(() => true)) continue;
    const { gone } = await closeBrowserSession(
      owner.env,
      {
        ...(options.runner !== undefined ? { runner: options.runner } : {}),
        ...(options.closeWaitMs !== undefined
          ? { closeWaitMs: options.closeWaitMs }
          : {}),
      },
    );
    if (gone) closed.push(owner.env.AGENT_BROWSER_SESSION!);
  }
  await rmdir(root).catch(() => undefined);
  return { closed };
}
