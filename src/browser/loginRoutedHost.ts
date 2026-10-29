import { mkdir } from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import type {
  BrowserEnv,
  BrowserHost,
  BrowserStageRequest,
  ProfileBrowser,
  ProfileBrowserRelease,
  ProfileBrowserRequest,
  ProfileBrowserResult,
} from "./browserHost.js";
import { closeBrowserSession } from "./browserTeardown.js";
import type { BrowserHostCapabilityRecord } from "./hostCapabilities.js";
import { type LoginCheckConfig, type LoginCheckOptions, runLoginCheck } from "./loginCheck.js";
import type { ProfileHostHints } from "./profileHostHint.js";
import type { ProfileHandle } from "./profileStore.js";
import { copySession } from "./sessionSeed.js";

export type LoginRoutedHostOptions = {
  /** Runs everything but human login stages (the headless browser the Host starts). */
  work: BrowserHost;
  /** Runs human login stages (the operator's own browser the Host attaches to). */
  login: BrowserHost;
  hints: ProfileHostHints;
  /** Profiles Host config pins to the login browser for every stage, for sites that reject a copied session. */
  pinnedProfiles?: ReadonlySet<string>;
  /** Folder for the one short-lived session file; defaults to a private folder in the Stageflow home. */
  tempDir?: string;
  loginCheck?: LoginCheckOptions;
};

/**
 * Sends human login stages to the operator's own browser, and every other stage to the
 * Host's headless one. When a login finishes, the session is copied once into the headless
 * browser's profile and checked there with the stage's own login check. If the site rejects
 * the copied session, the profile is remembered as "attach only" and the rest of the run, and
 * later runs, use the operator's browser.
 */
export function createLoginRoutedHost(options: LoginRoutedHostOptions): BrowserHost {
  const { work, login, hints } = options;
  const pinned = options.pinnedProfiles ?? new Set<string>();
  const loginChecks = new Map<string, LoginCheckConfig>();
  const profilesSeen = new Map<string, ProfileHandle>();
  const keyOf = (r: Pick<ProfileBrowserRequest, "runId" | "profile">) =>
    `${r.runId}\0${r.profile.key.scope}\0${r.profile.key.name}`;

  async function needsLoginBrowser(request: ProfileBrowserRequest): Promise<boolean> {
    if (request.humanLogin === true) return true;
    if (pinned.has(request.profile.key.name)) return true;
    return (await hints.get(request.profile)) !== undefined;
  }

  async function handOver(request: ProfileBrowserRequest, attached: ProfileBrowser): Promise<ProfileBrowserResult> {
    const { runner } = request;
    const local = await work.ensureProfileBrowser({ ...request, previous: undefined });
    const dir = options.tempDir ?? path.join(globalStageflowHome(), "browser", "tmp");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const copied = await copySession({ runner, from: attached.anchorEnv, to: local.anchorEnv, dir });
    const check = loginChecks.get(keyOf(request)) ?? request.browser.check;
    let accepted = copied;
    if (copied && check !== undefined) {
      const probe = await runLoginCheck(local.anchorEnv, check, runner, options.loginCheck).catch(() => undefined);
      accepted = probe?.state === "logged_in";
    }
    if (accepted) {
      await closeBrowserSession(attached.anchorEnv, { runner }).catch(() => undefined);
      return { ...local, via: "work", restarted: true };
    }
    await closeBrowserSession(local.anchorEnv, { runner }).catch(() => undefined);
    if (copied) {
      await hints.set(request.profile, {
        mode: "attach",
        reason: "the headless browser did not stay logged in with a copied session",
      });
    }
    return { cdpAddress: attached.cdpAddress, anchorEnv: attached.anchorEnv, via: "login", restarted: false };
  }

  const host: BrowserHost = {
    capabilities: work.capabilities,

    capabilitiesFor(request): BrowserHostCapabilityRecord | undefined {
      return request.humanLogin === true ? login.capabilities : work.capabilities;
    },

    async noteSiteBlocked(input) {
      const profile = profilesSeen.get(`${input.scope}\0${input.profile}`);
      if (profile === undefined) return { switched: false };
      const alreadyThere = pinned.has(input.profile) || (await hints.get(profile)) !== undefined;
      if (!alreadyThere) await hints.set(profile, { mode: "attach", reason: input.reason });
      return { switched: !alreadyThere };
    },

    async ensureProfileBrowser(request: ProfileBrowserRequest): Promise<ProfileBrowserResult> {
      const previous = request.previous;
      profilesSeen.set(`${request.profile.key.scope}\0${request.profile.key.name}`, request.profile);
      if (request.humanLogin === true && request.browser.check !== undefined) {
        loginChecks.set(keyOf(request), request.browser.check);
      }
      if (await needsLoginBrowser(request)) {
        if (previous?.via === "login") {
          const same = await login.ensureProfileBrowser(request);
          return { ...same, via: "login" };
        }
        if (previous !== undefined) {
          await closeBrowserSession(previous.anchorEnv, { runner: request.runner }).catch(() => undefined);
        }
        const attached = await login.ensureProfileBrowser({ ...request, previous: undefined });
        return { ...attached, via: "login", restarted: previous !== undefined ? true : attached.restarted };
      }
      if (previous?.via === "login") return handOver(request, previous);
      const local = await work.ensureProfileBrowser(request);
      return { ...local, via: "work" };
    },

    ...(work.releaseProfileBrowser !== undefined
      ? { releaseProfileBrowser: (request: ProfileBrowserRelease) => work.releaseProfileBrowser!(request) }
      : {}),
    ...(work.sweepOrphans !== undefined ? { sweepOrphans: (input: Parameters<NonNullable<BrowserHost["sweepOrphans"]>>[0]) => work.sweepOrphans!(input) } : {}),

    stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      return request.humanLogin === true ? login.stageEnv(request) : work.stageEnv(request);
    },

    profileBrowserEnv(request) {
      return work.profileBrowserEnv(request);
    },
  };
  return host;
}
