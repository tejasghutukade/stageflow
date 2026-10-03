import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stageDir } from "../runstore/paths.js";
import type { StageBrowserConfig } from "../types/stage.js";
import {
  BROWSER_ENV_FILENAME,
  type BrowserEnv,
  type StageBrowserSupport,
} from "./browserHost.js";
import { writeSessionOwner } from "./browserTeardown.js";
import { createLocalBrowserHost } from "./localBrowserHost.js";
import { createLocalProfileStore } from "./localProfileStore.js";
import { LOCAL_BROWSER_SCOPE } from "./profileStore.js";

export { BROWSER_ENV_FILENAME };

let defaultSupport: StageBrowserSupport | undefined;

export function defaultStageBrowserSupport(): StageBrowserSupport {
  defaultSupport ??= {
    host: createLocalBrowserHost(),
    profiles: createLocalProfileStore(),
  };
  return defaultSupport;
}

async function readPersisted(file: string): Promise<BrowserEnv | undefined> {
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

/**
 * Computed once per stage and persisted in the run dir: agent-browser silently
 * relaunches the browser when a command's launch env differs from the daemon's,
 * so every attempt and resume worker must see byte-identical values.
 */
export async function resolveStageBrowserEnv(
  support: StageBrowserSupport,
  input: {
    runId: string;
    stageId: string;
    runDir: string;
    browser: StageBrowserConfig | undefined;
  },
): Promise<BrowserEnv | undefined> {
  const { browser } = input;
  if (browser === undefined) return undefined;

  const dir = stageDir(input.runDir, input.stageId);
  const file = path.join(dir, BROWSER_ENV_FILENAME);

  const profile =
    browser.profile !== undefined
      ? await support.profiles.open({
          scope: LOCAL_BROWSER_SCOPE,
          name: browser.profile,
        })
      : undefined;
  const fresh = await support.host.stageEnv({
    runId: input.runId,
    stageId: input.stageId,
    browser,
    ...(profile !== undefined ? { profile } : {}),
  });

  const persisted = await readPersisted(file);
  const env = persisted ?? fresh;
  if (persisted === undefined) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }
  await writeSessionOwner({
    runId: input.runId,
    stageId: input.stageId,
    runDir: input.runDir,
    env,
  }).catch(() => undefined);
  return env;
}
