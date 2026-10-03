import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadHostConfig } from "../config/hostConfig.js";
import { stageDir } from "../runstore/paths.js";
import type { StageBrowserConfig } from "../types/stage.js";
import { safeAudit } from "./auditSink.js";
import { assertBrowserSitesAllowed } from "./sitePolicy.js";
import {
  BROWSER_ENV_FILENAME,
  BROWSER_POLICY_FILENAME,
  type BrowserEnv,
  type StageBrowserSupport,
} from "./browserHost.js";
import { writeSessionOwner } from "./browserTeardown.js";
import { ensureStageLoginCheck } from "./loginCheck.js";
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
    /** Attempt the login check result belongs to; defaults to 1. */
    attempt?: number;
  },
): Promise<BrowserEnv | undefined> {
  const { browser } = input;
  if (browser === undefined) return undefined;

  assertBrowserSitesAllowed(
    input.stageId,
    browser,
    support.blockedSites ?? loadHostConfig().browserBlockedSites,
  );

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
    if (browser.profile !== undefined) {
      await safeAudit(support.audit, {
        event: "profile_used",
        scope: LOCAL_BROWSER_SCOPE,
        profile: browser.profile,
        runId: input.runId,
        stageId: input.stageId,
      });
    }
    if (browser.profile !== undefined && (browser.allow_domains?.length ?? 0) > 0) {
      await writeFile(
        path.join(dir, BROWSER_POLICY_FILENAME),
        `${JSON.stringify({
          runId: input.runId,
          stageId: input.stageId,
          profile: browser.profile,
          allow_domains: browser.allow_domains,
        })}\n`,
        { mode: 0o600 },
      );
    }
  }
  await writeSessionOwner({
    runId: input.runId,
    stageId: input.stageId,
    runDir: input.runDir,
    env,
  }).catch(() => undefined);
  if (browser.check !== undefined) {
    await ensureStageLoginCheck({
      runDir: input.runDir,
      stageId: input.stageId,
      attempt: input.attempt ?? 1,
      env,
      check: browser.check,
      ...(support.runner !== undefined ? { runner: support.runner } : {}),
      ...(support.loginCheck !== undefined ? { options: support.loginCheck } : {}),
    });
  }
  return env;
}
