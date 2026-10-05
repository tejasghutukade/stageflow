import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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
import { ensureRunProfileBrowser } from "./anchor.js";
import {
  BROWSER_CLOSED_FILENAME,
  closeBrowserSession,
  defaultBrowserRunner,
  writeSessionOwner,
} from "./browserTeardown.js";
import { defaultDisplayProbe, loginPageUrl, noScreenError } from "./humanLogin.js";
import { ensureStageLoginCheck, OPEN_COMMAND_TIMEOUT_MS } from "./loginCheck.js";
import { resolveBrowserHostCapabilities } from "./hostCapabilities.js";
import { BROWSER_CAPABILITIES_FILENAME, readPersistedBrowserEnv } from "./persistedEnv.js";
import { createLocalBrowserHost } from "./localBrowserHost.js";
import { createLocalProfileStore } from "./localProfileStore.js";
import { LOCAL_BROWSER_SCOPE } from "./profileStore.js";

export { BROWSER_ENV_FILENAME };

export async function readStagePersistedBrowserEnv(
  runDir: string,
  stageId: string,
): Promise<BrowserEnv | undefined> {
  return readPersistedBrowserEnv(path.join(stageDir(runDir, stageId), BROWSER_ENV_FILENAME));
}

let defaultSupport: StageBrowserSupport | undefined;

export function hostLaunchOptions(): { launchArgs: string[]; executablePath?: string } {
  const config = loadHostConfig();
  return {
    launchArgs: config.browserLaunchArgs,
    ...(config.browserExecutablePath !== undefined
      ? { executablePath: config.browserExecutablePath }
      : {}),
  };
}

export function defaultStageBrowserSupport(): StageBrowserSupport {
  defaultSupport ??= {
    host: createLocalBrowserHost(hostLaunchOptions()),
    profiles: createLocalProfileStore(),
  };
  return defaultSupport;
}

let consoleSupport: StageBrowserSupport | undefined;

/** Browser support for a process that serves the live view routes (`sf ui`, `sf mcp`). */
export function consoleStageBrowserSupport(): StageBrowserSupport {
  consoleSupport ??= {
    host: createLocalBrowserHost({ liveView: "relay", ...hostLaunchOptions() }),
    profiles: createLocalProfileStore(),
  };
  return consoleSupport;
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
    /** Human login stage: needs a screen, opens the login page, skips the pre-agent check. */
    humanLogin?: boolean;
    /** Resume worker: the operator's window is already open; do not navigate it. */
    resuming?: boolean;
  },
): Promise<BrowserEnv | undefined> {
  const { browser } = input;
  if (browser === undefined) return undefined;

  const capabilities = resolveBrowserHostCapabilities(support.host.capabilities);
  if (support.host.capabilities === undefined) {
    capabilities.display = (support.display ?? defaultDisplayProbe)().hasDisplay
      ? "local_window"
      : "headless_only";
  } else if (
    capabilities.display === "local_window" &&
    support.display !== undefined &&
    !support.display().hasDisplay
  ) {
    capabilities.display = "headless_only";
  }
  if (
    input.humanLogin === true &&
    capabilities.display === "headless_only" &&
    capabilities.liveView === "none"
  ) {
    throw noScreenError((support.display ?? defaultDisplayProbe)().docker);
  }

  if (
    (browser.allow_domains?.length ?? 0) > 0 ||
    browser.check !== undefined ||
    browser.login_url !== undefined
  ) {
    assertBrowserSitesAllowed(
      input.stageId,
      browser,
      support.blockedSites ?? loadHostConfig().browserBlockedSites,
    );
  }

  const dir = stageDir(input.runDir, input.stageId);
  const file = path.join(dir, BROWSER_ENV_FILENAME);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, BROWSER_CAPABILITIES_FILENAME),
    `${JSON.stringify({ display: capabilities.display, liveView: capabilities.liveView })}\n`,
    { mode: 0o600 },
  );

  // TODO(multi-tenant): open the profile in the run owner's scope, not the fixed local scope.
  const profile =
    browser.profile !== undefined
      ? await support.profiles.open({
          scope: LOCAL_BROWSER_SCOPE,
          name: browser.profile,
        })
      : undefined;
  const anchor =
    profile !== undefined
      ? await ensureRunProfileBrowser(support, {
          runId: input.runId,
          runDir: input.runDir,
          browser,
          profile,
          ...(input.humanLogin === true ? { humanLogin: true } : {}),
        })
      : undefined;
  const fresh = await support.host.stageEnv({
    runId: input.runId,
    stageId: input.stageId,
    browser,
    ...(profile !== undefined ? { profile } : {}),
    ...(anchor !== undefined ? { cdpAddress: anchor.cdpAddress } : {}),
    ...(input.humanLogin === true ? { humanLogin: true } : {}),
  });

  await rm(path.join(dir, BROWSER_CLOSED_FILENAME), { force: true });
  const persisted = await readPersistedBrowserEnv(file);
  let env = persisted ?? fresh;
  const writeEnv = async (value: BrowserEnv) => {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  };
  if (
    persisted !== undefined &&
    anchor !== undefined &&
    persisted.AGENT_BROWSER_CDP !== anchor.cdpAddress
  ) {
    // The shared browser was restarted: only the attach address changes. The
    // old stage daemon is still attached to the dead address, so close it first.
    await closeBrowserSession(persisted, {
      ...(support.runner !== undefined ? { runner: support.runner } : {}),
      ...(support.closeWaitMs !== undefined ? { closeWaitMs: support.closeWaitMs } : {}),
    }).catch(() => undefined);
    if (persisted.AGENT_BROWSER_SOCKET_DIR !== undefined) {
      await mkdir(persisted.AGENT_BROWSER_SOCKET_DIR, { recursive: true, mode: 0o700 });
    }
    env = { ...persisted, AGENT_BROWSER_CDP: anchor.cdpAddress };
    await writeEnv(env);
  }
  if (persisted === undefined) {
    await writeEnv(fresh);
    if (browser.profile !== undefined) {
      // TODO(multi-tenant): audit the run owner's scope.
      await safeAudit(support.audit, {
        event: "profile_used",
        scope: LOCAL_BROWSER_SCOPE,
        profile: browser.profile,
        runId: input.runId,
        stageId: input.stageId,
      });
    }
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
  await writeSessionOwner({
    runId: input.runId,
    stageId: input.stageId,
    runDir: input.runDir,
    env,
  }).catch(() => undefined);
  if (input.humanLogin === true) {
    const url = input.resuming === true ? undefined : loginPageUrl(browser);
    if (url !== undefined) {
      const opened = await (support.runner ?? defaultBrowserRunner)(["open", url], env, {
        timeoutMs: OPEN_COMMAND_TIMEOUT_MS,
      });
      if (opened.code !== 0) {
        throw new Error(`could not open the login page ${url}`);
      }
    }
  } else if (browser.check !== undefined) {
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
