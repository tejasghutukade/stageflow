import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { auditLastUsedByProfile } from "./auditSink.js";
import type { StageBrowserSupport } from "./browserHost.js";
import { closeBrowserSession } from "./browserTeardown.js";
import { localOwnerScope } from "./ownerScope.js";
import { createProfileHostHints, type ProfileHostHints } from "./profileHostHint.js";
import { defaultProfileMetaStore } from "./profileMeta.js";
import { stageProfileLock } from "./stageProfileLock.js";
import { createProfileLoginFlow, type CheckOutcome, type LoginFinish, type LoginStart, type ProfileLoginFlow } from "./profileLoginFlow.js";
import type { ProfileLock, RunLiveness } from "./profileLock.js";
import type { LoginWhere, ProfileMetaStore } from "./profileMeta.js";
import { type ProfileHandle, type ProfileStore, validateProfileName } from "./profileStore.js";

export type ProfileCatalogErrorCode = "not_found" | "profile_busy" | "pinned_by_config" | "not_pinned" | "unsupported";

export class ProfileCatalogError extends Error {
  constructor(
    message: string,
    readonly code: ProfileCatalogErrorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProfileCatalogError";
  }
}

/** Why a profile's stages use the operator's own Chrome. */
export type ProfilePin = { by: "learned" | "config"; reason: string; at: string | null };

/** What the console and the CLI may show about a saved login. Never a cookie, token or folder. */
export type ProfileSummary = {
  name: string;
  scope: string;
  sites: string[];
  login_where: LoginWhere | null;
  last_login_at: string | null;
  last_verified_at: string | null;
  last_used_at: string | null;
  pinned: ProfilePin | null;
  in_use: { run_id: string; stage_id: string | null; live: boolean } | null;
  /** True once a stage has recorded how to check this login; Check now and Log in again need it. */
  can_check: boolean;
  /** True while Log in again is waiting for the operator. */
  logging_in: boolean;
};

export type ProfileCatalogDeps = {
  scope: string;
  profiles: ProfileStore;
  locks: ProfileLock;
  isRunLive: RunLiveness;
  hints: ProfileHostHints;
  meta: ProfileMetaStore;
  /** Profile name to ISO time of the last recorded use (the audit log). */
  auditLastUsed: (scope: string) => Promise<Record<string, string>>;
  /** Profiles Host config pins to the operator's own Chrome; these cannot be unpinned here. */
  pinnedByConfig: ReadonlySet<string>;
  /** Closes the browser session a profile may still have open; failures are ignored. */
  closeProfileSession: (profile: ProfileHandle) => Promise<void>;
  /** Check now and Log in again; absent where the host cannot drive a browser (the CLI). */
  flow?: ProfileLoginFlow;
};

export interface ProfileCatalog {
  list(): Promise<ProfileSummary[]>;
  get(name: string): Promise<ProfileSummary>;
  /** Deletes the Host's saved login data for the profile and forgets its metadata and pin. */
  remove(name: string): Promise<void>;
  /** Forgets the learned "use the operator's Chrome" pin, so the Host's own browser is tried again. */
  unpin(name: string): Promise<ProfileSummary>;
  /** Runs the profile's login check in the browser its stages use. */
  checkNow(name: string): Promise<{ state: CheckOutcome["state"]; site: string | null; profile: ProfileSummary }>;
  /** Opens the login page where the operator can use it and waits for `finishLogin`. */
  startLogin(name: string): Promise<LoginStart & { profile: ProfileSummary }>;
  /** Verifies the login. `ok: false` leaves the login waiting so the operator can try again. */
  finishLogin(name: string): Promise<LoginFinish & { profile: ProfileSummary }>;
  cancelLogin(name: string): Promise<ProfileSummary>;
}

export function createProfileCatalog(deps: ProfileCatalogDeps): ProfileCatalog {
  const { scope } = deps;

  async function summarize(handle: ProfileHandle, audited: Record<string, string>): Promise<ProfileSummary> {
    const name = handle.key.name;
    const meta = await deps.meta.get(handle);
    const hint = await deps.hints.get(handle);
    const holder = await deps.locks.holder({ scope, name });
    let lastUsed = audited[name];
    if (handle.profileDir !== undefined) {
      try {
        const iso = (await stat(handle.profileDir)).mtime.toISOString();
        if (lastUsed === undefined || iso > lastUsed) lastUsed = iso;
      } catch {
        // folder not created yet
      }
    }
    const pinned: ProfilePin | null = deps.pinnedByConfig.has(name)
      ? { by: "config", reason: "pinned in Host config (browser.profile_hosts)", at: null }
      : hint !== undefined
        ? { by: "learned", reason: hint.reason, at: hint.at }
        : null;
    return {
      name,
      scope,
      sites: meta?.sites ?? [],
      login_where: meta?.login_where ?? null,
      last_login_at: meta?.last_login_at ?? null,
      last_verified_at: meta?.last_verified_at ?? null,
      last_used_at: lastUsed ?? null,
      pinned,
      in_use:
        holder === undefined
          ? null
          : {
              run_id: holder.runId,
              stage_id: holder.stageId ?? null,
              live: await deps.isRunLive(holder.runId).catch(() => true),
            },
      can_check: meta?.check !== undefined,
      logging_in: deps.flow?.isLoggingIn(handle) === true,
    };
  }

  async function open(rawName: string): Promise<ProfileHandle> {
    const name = validateProfileName(rawName);
    if (!(await deps.profiles.list(scope)).includes(name)) {
      throw new ProfileCatalogError(`Profile "${name}" does not exist.`, "not_found", 404);
    }
    return deps.profiles.open({ scope, name });
  }

  async function withFlow(name: string): Promise<{ handle: ProfileHandle; flow: ProfileLoginFlow }> {
    const handle = await open(name);
    if (deps.flow === undefined) {
      throw new ProfileCatalogError("This Host cannot open a browser from here.", "unsupported", 501);
    }
    return { handle, flow: deps.flow };
  }

  return {
    async list() {
      const audited = await deps.auditLastUsed(scope).catch(() => ({}) as Record<string, string>);
      const out: ProfileSummary[] = [];
      for (const name of await deps.profiles.list(scope)) {
        out.push(await summarize(await deps.profiles.open({ scope, name }), audited));
      }
      return out;
    },

    async get(name) {
      const handle = await open(name);
      return summarize(handle, await deps.auditLastUsed(scope).catch(() => ({}) as Record<string, string>));
    },

    async remove(name) {
      const handle = await open(name);
      const owner = { runId: `cli-${process.pid}-${randomBytes(4).toString("hex")}`, stageId: "browser-profiles" };
      const got = await deps.locks.acquire({ scope, name: handle.key.name }, owner);
      if (got.status === "queued") {
        throw new ProfileCatalogError(
          `Profile "${handle.key.name}" is in use by run ${got.holder.runId}${got.holder.stageId !== undefined ? ` stage ${got.holder.stageId}` : ""}. Try again when it finishes.`,
          "profile_busy",
          409,
        );
      }
      try {
        await deps.closeProfileSession(handle).catch(() => undefined);
        await deps.hints.clear(handle).catch(() => undefined);
        await deps.meta.clear(handle).catch(() => undefined);
        await deps.profiles.delete({ scope, name: handle.key.name });
      } finally {
        await got.release().catch(() => undefined);
      }
    },

    async unpin(name) {
      const handle = await open(name);
      if (deps.pinnedByConfig.has(handle.key.name)) {
        throw new ProfileCatalogError(
          `Profile "${handle.key.name}" is pinned in Host config (browser.profile_hosts). Remove it there.`,
          "pinned_by_config",
          409,
        );
      }
      if ((await deps.hints.get(handle)) === undefined) {
        throw new ProfileCatalogError(`Profile "${handle.key.name}" is not pinned to the operator's Chrome.`, "not_pinned", 409);
      }
      await deps.hints.clear(handle);
      return this.get(handle.key.name);
    },

    async checkNow(name) {
      const { handle, flow } = await withFlow(name);
      const result = await flow.check(handle, (await deps.meta.get(handle)) ?? { });
      return { ...result, profile: await this.get(name) };
    },

    async startLogin(name) {
      const { handle, flow } = await withFlow(name);
      const result = await flow.startLogin(handle, (await deps.meta.get(handle)) ?? {});
      return { ...result, profile: await this.get(name) };
    },

    async finishLogin(name) {
      const { handle, flow } = await withFlow(name);
      const result = await flow.finishLogin(handle);
      return { ...result, profile: await this.get(name) };
    },

    async cancelLogin(name) {
      const { handle, flow } = await withFlow(name);
      await flow.cancelLogin(handle);
      return this.get(name);
    },
  };
}

/** The catalog for a running Host: its browser support, run store and Host config. */
export function createHostProfileCatalog(input: {
  support: StageBrowserSupport;
  isRunLive: RunLiveness;
  pinnedByConfig: ReadonlySet<string>;
  scope?: string;
}): ProfileCatalog {
  const { support } = input;
  return createProfileCatalog({
    scope: input.scope ?? localOwnerScope(),
    profiles: support.profiles,
    locks: stageProfileLock(support),
    isRunLive: input.isRunLive,
    hints: createProfileHostHints(),
    meta: defaultProfileMetaStore(),
    auditLastUsed: auditLastUsedByProfile,
    pinnedByConfig: input.pinnedByConfig,
    flow: createProfileLoginFlow({ support, scope: input.scope ?? localOwnerScope() }),
    async closeProfileSession(profile) {
      const env = await support.host.profileBrowserEnv({
        runId: `cli-${process.pid}-profiles`,
        browser: { profile: profile.key.name },
        profile,
      });
      await closeBrowserSession(env, {
        ...(support.runner !== undefined ? { runner: support.runner } : {}),
        ...(support.closeWaitMs !== undefined ? { closeWaitMs: support.closeWaitMs } : {}),
      });
    },
  });
}
