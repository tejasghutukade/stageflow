import { readFile } from "node:fs/promises";
import type { BrowserEnv } from "./browserHost.js";
import {
  resolveBrowserHostCapabilities,
  type BrowserHostCapabilities,
  type BrowserHostCapabilityRecord,
} from "./hostCapabilities.js";

export const BROWSER_CAPABILITIES_FILENAME = "browser-capabilities.json";

/** Capabilities persisted at resolve time; absent (older runs, direct stage runs) reads as a local window. */
export async function readPersistedBrowserCapabilities(
  file: string,
): Promise<BrowserHostCapabilities> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return resolveBrowserHostCapabilities(parsed as BrowserHostCapabilityRecord);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return resolveBrowserHostCapabilities({ display: "local_window" });
}

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
