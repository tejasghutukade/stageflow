import { readFile } from "node:fs/promises";
import type { BrowserEnv } from "./browserHost.js";

/** Reads a persisted browser env; undefined when absent, throws on other I/O errors. */
export async function readPersistedBrowserEnv(
  file: string,
): Promise<BrowserEnv | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as BrowserEnv;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return undefined;
}
