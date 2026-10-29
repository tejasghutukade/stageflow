import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserEnv, BrowserRunner } from "./browserHost.js";

/**
 * Copies a logged-in session (cookies and web storage) from one browser to another
 * through a short-lived file. The file is owner-only, lives in `dir`, and is deleted
 * before this returns, so the session is never kept outside the target browser's profile.
 * It never appears in an envelope, a log or an artifact; callers get only a boolean.
 */
export async function copySession(input: {
  runner: BrowserRunner;
  from: BrowserEnv;
  to: BrowserEnv;
  /** Host-owned folder for the one temporary file. */
  dir: string;
}): Promise<boolean> {
  let folder: string | undefined;
  try {
    folder = await mkdtemp(path.join(input.dir, "session-"));
    const file = path.join(folder, "state.json");
    const saved = await input.runner(["state", "save", file], input.from);
    if (saved.code !== 0) return false;
    const loaded = await input.runner(["state", "load", file], input.to);
    return loaded.code === 0;
  } catch {
    return false;
  } finally {
    if (folder !== undefined) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
