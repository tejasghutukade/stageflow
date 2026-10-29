import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import type { StageBrowserSupport } from "./browserHost.js";
import { defaultBrowserRunner, teardownRunBrowsers, teardownStageBrowser } from "./browserTeardown.js";
import { type LoginState, readStageLoginCheck, runLoginCheck } from "./loginCheck.js";
import { type LoginWhere, type ProfileRecipe, recordProfileSession, stageSites } from "./profileMeta.js";
import type { ProfileHandle } from "./profileStore.js";
import { readStagePersistedBrowserEnv, resolveStageBrowserEnv } from "./stageBrowserEnv.js";
import { readStageHandoff, resolveStageHandoffCapabilities } from "./stageHandoff.js";
import { stageProfileLock } from "./stageProfileLock.js";
import { hostOf } from "./sitePolicy.js";

export type LoginFlowErrorCode =
  | "no_recipe"
  | "profile_busy"
  | "login_unsupported"
  | "login_in_progress"
  | "no_login"
  | "login_failed";

export class LoginFlowError extends Error {
  constructor(
    message: string,
    readonly code: LoginFlowErrorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = "LoginFlowError";
  }
}

export type CheckOutcome = { state: LoginState; site: string | null };
export type LoginStart = { where: "own_chrome" | "host_window"; site: string | null };
export type LoginFinish = { ok: boolean; state: LoginState; where: LoginWhere };

export interface ProfileLoginFlow {
  /** Runs the profile's own login check in the browser its stages use, then closes everything it opened. */
  check(profile: ProfileHandle, recipe: ProfileRecipe): Promise<CheckOutcome>;
  /** Opens the login page in a browser the operator can use and keeps the profile's lease until finish or cancel. */
  startLogin(profile: ProfileHandle, recipe: ProfileRecipe): Promise<LoginStart>;
  /** Checks the login. When it holds, copies it to the Host's browser the way a login stage does and ends the flow. */
  finishLogin(profile: ProfileHandle): Promise<LoginFinish>;
  cancelLogin(profile: ProfileHandle): Promise<void>;
  isLoggingIn(profile: ProfileHandle): boolean;
}

type Active = {
  runId: string;
  runDir: string;
  recipe: ProfileRecipe;
  where: LoginStart["where"];
  timer: NodeJS.Timeout;
  release: () => Promise<void>;
};

const DEFAULT_TTL_MS = 15 * 60_000;

function siteOf(recipe: ProfileRecipe): string | null {
  const url = recipe.check?.url ?? recipe.login_url;
  return url === undefined ? null : (hostOf(url) ?? null);
}

/**
 * "Check now" and "Log in again" for a saved profile. Both run through the same Host code a
 * stage uses (`resolveStageBrowserEnv`), so they pick the same browser a stage would (the Host's
 * own, or the operator's Chrome for a pinned profile) and the same session copy.
 */
export function createProfileLoginFlow(input: {
  support: StageBrowserSupport;
  scope: string;
  ttlMs?: number;
  tmpRoot?: string;
}): ProfileLoginFlow {
  const { support, scope } = input;
  const active = new Map<string, Active>();
  const runner = support.runner ?? defaultBrowserRunner;
  const keyOf = (p: ProfileHandle) => `${p.key.scope}\0${p.key.name}`;

  async function workDir(): Promise<string> {
    const root = input.tmpRoot ?? path.join(globalStageflowHome(), "browser", "tmp");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return mkdtemp(path.join(root, "flow-"));
  }

  async function lease(profile: ProfileHandle): Promise<{ runId: string; release: () => Promise<void> }> {
    const runId = `cli-${process.pid}-${randomBytes(4).toString("hex")}`;
    const got = await stageProfileLock(support).acquire(
      { scope, name: profile.key.name },
      { runId, stageId: "browser-profiles" },
    );
    if (got.status === "queued") {
      throw new LoginFlowError(
        `Profile "${profile.key.name}" is in use by run ${got.holder.runId}. Try again when it finishes.`,
        "profile_busy",
        409,
      );
    }
    return { runId, release: () => got.release().catch(() => undefined) };
  }

  async function cleanup(runId: string, runDir: string, release: () => Promise<void>): Promise<void> {
    await teardownRunBrowsers(support, { runId, runDir }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    await release();
  }

  function requireCheck(recipe: ProfileRecipe): NonNullable<ProfileRecipe["check"]> {
    if (recipe.check === undefined) {
      throw new LoginFlowError(
        "No login check is recorded for this profile yet. Run a pipeline that uses it once, then try again.",
        "no_recipe",
        409,
      );
    }
    return recipe.check;
  }

  const forget = async (profile: ProfileHandle, flow: Active | undefined) => {
    if (flow === undefined) return;
    clearTimeout(flow.timer);
    active.delete(keyOf(profile));
    await cleanup(flow.runId, flow.runDir, flow.release);
  };

  return {
    isLoggingIn: (profile) => active.has(keyOf(profile)),

    async check(profile, recipe) {
      const check = requireCheck(recipe);
      if (active.has(keyOf(profile))) {
        throw new LoginFlowError("A login for this profile is in progress. Finish or cancel it first.", "login_in_progress", 409);
      }
      const { runId, release } = await lease(profile);
      const runDir = await workDir();
      try {
        await resolveStageBrowserEnv(support, {
          runId,
          stageId: "check",
          scope,
          runDir,
          browser: { profile: profile.key.name, check },
        });
        const result = await readStageLoginCheck(runDir, "check");
        return { state: result?.state ?? "unknown", site: siteOf(recipe) };
      } finally {
        await cleanup(runId, runDir, release);
      }
    },

    async startLogin(profile, recipe) {
      const check = requireCheck(recipe);
      if (active.has(keyOf(profile))) {
        throw new LoginFlowError("A login for this profile is already in progress.", "login_in_progress", 409);
      }
      let capabilities: ReturnType<typeof resolveStageHandoffCapabilities>;
      try {
        capabilities = resolveStageHandoffCapabilities(support, { humanLogin: true });
      } catch (error) {
        throw new LoginFlowError((error as Error).message, "login_unsupported", 409);
      }
      if (capabilities.display !== "local_window") {
        throw new LoginFlowError(
          "Logging in from here needs a window: set browser.login_host: attach (your own Chrome) or run the Host on a computer with a screen. Run a pipeline with a login stage to use the live view instead.",
          "login_unsupported",
          409,
        );
      }
      const { runId, release } = await lease(profile);
      const runDir = await workDir();
      try {
        await resolveStageBrowserEnv(support, {
          runId,
          stageId: "login",
          scope,
          runDir,
          browser: {
            profile: profile.key.name,
            check,
            ...(recipe.login_url !== undefined ? { login_url: recipe.login_url } : {}),
          },
          humanLogin: true,
        });
      } catch (error) {
        await cleanup(runId, runDir, release);
        throw new LoginFlowError((error as Error).message, "login_failed", 502);
      }
      const where: LoginStart["where"] = capabilities.ownBrowser === true ? "own_chrome" : "host_window";
      const flow: Active = {
        runId,
        runDir,
        recipe,
        where,
        release,
        timer: setTimeout(() => void forget(profile, active.get(keyOf(profile))), input.ttlMs ?? DEFAULT_TTL_MS),
      };
      flow.timer.unref?.();
      active.set(keyOf(profile), flow);
      return { where, site: siteOf(recipe) };
    },

    async finishLogin(profile) {
      const flow = active.get(keyOf(profile));
      if (flow === undefined) {
        throw new LoginFlowError("No login is in progress for this profile.", "no_login", 404);
      }
      const check = requireCheck(flow.recipe);
      const env = await readStagePersistedBrowserEnv(flow.runDir, "login");
      if (env === undefined) {
        await forget(profile, flow);
        throw new LoginFlowError("The login browser is gone. Start again.", "login_failed", 409);
      }
      const observed = await runLoginCheck(env, check, runner, support.loginCheck).catch(() => undefined);
      if (observed === undefined || observed.logged_in !== true) {
        return { ok: false, state: observed?.state ?? "unknown", where: flow.where === "own_chrome" ? "own_chrome" : "host_browser" };
      }
      // Same step a login stage's successor takes: close the login tab, then start work in the Host's browser.
      await teardownStageBrowser(support, { runId: flow.runId, runDir: flow.runDir, stageId: "login" }).catch(() => undefined);
      let where: LoginWhere = flow.where === "own_chrome" ? "own_chrome" : "host_browser";
      let state: LoginState = "logged_in";
      try {
        await resolveStageBrowserEnv(support, {
          runId: flow.runId,
          stageId: "work",
          scope,
          runDir: flow.runDir,
          browser: { profile: profile.key.name, check },
        });
        const handoff = await readStageHandoff({ runDir: flow.runDir, stageId: "work" });
        where = handoff?.ownBrowser === true ? "own_chrome" : "host_browser";
        state = (await readStageLoginCheck(flow.runDir, "work"))?.state ?? "unknown";
      } finally {
        await forget(profile, flow);
      }
      const now = new Date().toISOString();
      await recordProfileSession(profile, {
        sites: stageSites({ profile: profile.key.name, check, ...(flow.recipe.login_url !== undefined ? { login_url: flow.recipe.login_url } : {}) }),
        login_at: now,
        ...(state === "logged_in" ? { verified_at: now } : {}),
        where,
        check,
        ...(flow.recipe.login_url !== undefined ? { login_url: flow.recipe.login_url } : {}),
      });
      return { ok: true, state, where };
    },

    async cancelLogin(profile) {
      await forget(profile, active.get(keyOf(profile)));
    },
  };
}
