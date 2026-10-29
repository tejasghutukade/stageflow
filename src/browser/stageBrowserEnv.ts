import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserHostForOwner, loadHostConfig } from "../config/hostConfig.js";
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
import { defaultDisplayProbe, loginPageUrl } from "./humanLogin.js";
import { persistStageHandoff, resolveStageHandoffCapabilities } from "./stageHandoff.js";
import { ensureStageLoginCheck, OPEN_COMMAND_TIMEOUT_MS } from "./loginCheck.js";
import { readPersistedBrowserEnv } from "./persistedEnv.js";
import { createAttachBrowserHost } from "./attachBrowserHost.js";
import { createLoginRoutedHost } from "./loginRoutedHost.js";
import { recordProfileSession, stageSites } from "./profileMeta.js";
import { createProfileHostHints } from "./profileHostHint.js";
import { createContainerBrowserHost } from "./containerBrowserHost.js";
import { createDockerSandboxOrchestrator } from "./dockerSandboxOrchestrator.js";
import { createVolumeProfileStore } from "./volumeProfileStore.js";
import { createLocalBrowserHost } from "./localBrowserHost.js";
import { createLocalProfileStore } from "./localProfileStore.js";
import { localOwnerScope } from "./ownerScope.js";

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

function configuredBrowserSupport(liveView: "relay" | "none"): StageBrowserSupport {
  const config = loadHostConfig();
  const kind = browserHostForOwner(config, localOwnerScope());
  const attached =
    config.browserAttach !== undefined
      ? createAttachBrowserHost({ cdpUrl: config.browserAttach.cdpUrl, liveView, local: hostLaunchOptions() })
      : undefined;
  if (kind === "attach" && attached !== undefined) {
    return { host: attached, profiles: createVolumeProfileStore() };
  }
  const support: StageBrowserSupport =
    kind === "container"
      ? {
          host: createContainerBrowserHost({
            orchestrator: createDockerSandboxOrchestrator({
              image: config.browserContainer.image,
              shmSize: config.browserContainer.shmSize,
              memory: config.browserContainer.memory,
              pidsLimit: config.browserContainer.pidsLimit,
              user: "1000:1000",
            }),
            liveView,
            local: hostLaunchOptions(),
          }),
          profiles: createVolumeProfileStore(),
        }
      : {
          host: createLocalBrowserHost({ liveView, ...hostLaunchOptions() }),
          profiles: createLocalProfileStore(),
        };
  const routed = config.browserLoginHost === "attach" || Object.keys(config.browserProfileHosts).length > 0;
  if (routed && attached !== undefined) {
    return {
      ...support,
      host: createLoginRoutedHost({
        work: support.host,
        login: attached,
        hints: createProfileHostHints(),
        pinnedProfiles: new Set(Object.keys(config.browserProfileHosts)),
      }),
    };
  }
  return support;
}

export function defaultStageBrowserSupport(): StageBrowserSupport {
  defaultSupport ??= configuredBrowserSupport("none");
  return defaultSupport;
}

let consoleSupport: StageBrowserSupport | undefined;

/** Browser support for a process that serves the live view routes (`sf ui`, `sf mcp`). */
export function consoleStageBrowserSupport(): StageBrowserSupport {
  consoleSupport ??= configuredBrowserSupport("relay");
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
    scope: string;
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

  const capabilities = resolveStageHandoffCapabilities(support, {
    ...(input.humanLogin === true ? { humanLogin: true } : {}),
  });

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
  await persistStageHandoff({ runDir: input.runDir, stageId: input.stageId }, capabilities);

  const profile =
    browser.profile !== undefined
      ? await support.profiles.open({
          scope: input.scope,
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
  if (anchor?.via === "login" && input.humanLogin !== true) {
    await persistStageHandoff(
      { runDir: input.runDir, stageId: input.stageId },
      { display: "local_window", liveView: capabilities.liveView, ownBrowser: true },
    );
  }
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
      await safeAudit(support.audit, {
        event: "profile_used",
        scope: input.scope,
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
    const checked = await ensureStageLoginCheck({
      runDir: input.runDir,
      stageId: input.stageId,
      attempt: input.attempt ?? 1,
      env,
      check: browser.check,
      ...(support.runner !== undefined ? { runner: support.runner } : {}),
      ...(support.loginCheck !== undefined ? { options: support.loginCheck } : {}),
    });
    if (checked.logged_in === true && profile !== undefined) {
      await recordProfileSession(profile, {
        sites: stageSites(browser),
        verified_at: new Date().toISOString(),
        where: anchor?.via === "login" ? "own_chrome" : "host_browser",
      });
    }
  }
  return env;
}
