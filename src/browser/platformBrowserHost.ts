import {
  type BrowserEnv,
  type BrowserHost,
  type BrowserStageRequest,
  type ProfileBrowserRelease,
  type ProfileBrowserRequest,
  type ProfileBrowserResult,
  type StageBrowserRelease,
} from "./browserHost.js";
import type { BrowserHostCapabilityRecord } from "./hostCapabilities.js";
import { createLocalBrowserHost, type LocalBrowserHostOptions } from "./localBrowserHost.js";
import { type ProfileStore, validateProfileKey, validateProfileScope } from "./profileStore.js";
import { createVolumeProfileStore } from "./volumeProfileStore.js";

export const PLATFORM_URL_ENV = "STAGEFLOW_PLATFORM_URL";
export const PLATFORM_TOKEN_ENV = "STAGEFLOW_PLATFORM_TOKEN";

/** A platform answer the stage can act on; carries a code, never a response body, URL or token. */
export class PlatformBrowserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type PlatformBrowserClientOptions = {
  /** Base address of the hosting platform (`STAGEFLOW_PLATFORM_URL`). */
  url: string;
  /** This Host's platform token (`STAGEFLOW_PLATFORM_TOKEN`); it names the Host to the platform. Never logged or put in an error. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type PlatformBrowserClient = {
  createSession(input: { runId: string; stageId?: string; profile?: string; allowDomains?: string[] }): Promise<{ connectUrl: string }>;
  release(input: { runId: string; stageId?: string; profile?: string }): Promise<void>;
  /** Whether the browser with these tags is still running on the platform (it ends at the platform's time limit). */
  alive(input: { runId: string; stageId?: string; profile?: string }): Promise<boolean>;
  runs(): Promise<string[]>;
  profiles(): Promise<string[]>;
  deleteProfile(name: string): Promise<void>;
};

const MESSAGES: Record<string, string> = {
  browser_capacity: "No remote browser is free right now. Run the stage again in a minute.",
  browser_workspace_limit: "This workspace already uses as many remote browsers as it may. Wait for another browser stage to finish.",
  browser_profile_busy: "Another run is using this browser profile.",
  workspace_not_running: "The platform says this workspace is not running.",
  unauthorized: "The platform refused this Host's token.",
};

export function createPlatformBrowserClient(options: PlatformBrowserClientOptions): PlatformBrowserClient {
  const request = options.fetch ?? fetch;
  const base = `${options.url.replace(/\/$/, "")}/_gw/host/browser`;
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await request(`${base}/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch {
      throw new PlatformBrowserError("platform_unreachable", "The hosting platform's browser service did not answer.");
    }
    const parsed = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
    if (!res.ok) {
      const code = typeof parsed?.error === "string" && /^[a-z_]{1,64}$/.test(parsed.error) ? parsed.error : `platform_http_${res.status}`;
      throw new PlatformBrowserError(code, MESSAGES[code] ?? `The hosting platform's browser service failed (${code}).`);
    }
    return parsed;
  }
  return {
    async createSession(input) {
      const answer = (await call("POST", "sessions", input)) as { connectUrl?: unknown } | undefined;
      if (typeof answer?.connectUrl !== "string" || !/^wss?:\/\//.test(answer.connectUrl)) {
        throw new PlatformBrowserError("platform_bad_answer", "The hosting platform returned no browser address.");
      }
      return { connectUrl: answer.connectUrl };
    },
    async release(input) {
      await call("POST", "release", input);
    },
    async alive(input) {
      const answer = (await call("POST", "alive", input)) as { alive?: unknown } | undefined;
      return answer?.alive === true;
    },
    async runs() {
      const answer = (await call("GET", "runs")) as { runIds?: unknown } | undefined;
      return Array.isArray(answer?.runIds) ? answer.runIds.filter((id): id is string => typeof id === "string") : [];
    },
    async profiles() {
      const answer = (await call("GET", "profiles")) as { profiles?: unknown } | undefined;
      return Array.isArray(answer?.profiles) ? answer.profiles.filter((name): name is string => typeof name === "string") : [];
    },
    async deleteProfile(name) {
      await call("DELETE", `profiles/${encodeURIComponent(name)}`);
    },
  };
}

export type PlatformBrowserHostOptions = {
  client: PlatformBrowserClient;
  /** Builds session names, socket dirs and the empty config file the way the local host does. */
  base?: BrowserHost;
  local?: LocalBrowserHostOptions;
};

/**
 * Browsers from the hosting platform. The Host runs no browser: each run's profile browser and each
 * profile-less stage's browser is a remote session the platform creates, and the stage attaches to
 * it over CDP. The platform keeps saved logins (`profilePersistence: provider_managed`).
 */
export function createPlatformBrowserHost(options: PlatformBrowserHostOptions): BrowserHost {
  const base = options.base ?? createLocalBrowserHost(options.local);
  const { client } = options;
  /** One remote browser per profile-less stage: asking again for the same stage returns the same one. */
  const stageBrowsers = new Map<string, Promise<{ connectUrl: string }>>();
  const stageKey = (runId: string, stageId: string) => `${runId}\0${stageId}`;

  const capabilities: BrowserHostCapabilityRecord = {
    display: "headless_only",
    liveView: "none",
    attach: "cdp",
    profilePersistence: "provider_managed",
    gracefulCloseRequired: false,
    hardAllowlist: true,
  };

  return {
    capabilities,

    async ensureProfileBrowser(request: ProfileBrowserRequest): Promise<ProfileBrowserResult> {
      if (request.humanLogin === true) {
        throw new PlatformBrowserError("platform_no_human_login", "Logging in by hand is not available on this host yet. Log in from a local Stageflow and use the profile there.");
      }
      // TODO(multi-tenant): the platform keys profiles by name within the Host's workspace; pass the owner scope when one Host serves several.
      const profile = request.profile.key.name;
      if (request.previous !== undefined) {
        if (await client.alive({ runId: request.runId, profile })) return { ...request.previous, restarted: false };
        // Ended at the platform's time limit or by a sweep: make sure nothing is left, then start a new one.
        await client.release({ runId: request.runId, profile }).catch(() => undefined);
      }
      const { connectUrl } = await client.createSession({ runId: request.runId, profile });
      const env = await base.stageEnv({
        runId: request.runId,
        stageId: `anchor:${request.profile.key.name}`,
        browser: request.browser,
        profile: request.profile,
        cdpAddress: connectUrl,
      });
      delete env.AGENT_BROWSER_PIN_TAB;
      return { cdpAddress: connectUrl, anchorEnv: env, restarted: request.previous !== undefined };
    },

    async releaseProfileBrowser(request: ProfileBrowserRelease): Promise<void> {
      await client.release({ runId: request.runId, profile: request.profile });
    },

    async releaseStageBrowser(request: StageBrowserRelease): Promise<void> {
      if (request.shared) return;
      await client.release({ runId: request.runId, stageId: request.stageId });
      stageBrowsers.delete(stageKey(request.runId, request.stageId));
    },

    stageBrowserAlive(request: { runId: string; stageId: string }): Promise<boolean> {
      return client.alive(request);
    },

    // One Host per platform workspace: a run this Host does not know is not live anywhere.
    async sweepOrphans(input): Promise<{ released: string[] }> {
      const released: string[] = [];
      for (const runId of await client.runs()) {
        if (await input.isRunLive(runId)) continue;
        await client.release({ runId });
        released.push(runId);
      }
      return { released };
    },

    async profileBrowserEnv(): Promise<BrowserEnv> {
      throw new PlatformBrowserError("platform_no_profile_folder", "This host keeps saved logins on the platform; there is no profile folder to open.");
    },

    async stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      if (request.profile !== undefined) return base.stageEnv(request);
      const allow = request.browser.allow_domains;
      const key = stageKey(request.runId, request.stageId);
      let pending = stageBrowsers.get(key);
      if (pending === undefined) {
        pending = client.createSession({
          runId: request.runId,
          stageId: request.stageId,
          ...(allow !== undefined && allow.length > 0 ? { allowDomains: allow } : {}),
        });
        stageBrowsers.set(key, pending);
        pending.catch(() => stageBrowsers.delete(key));
      }
      const { connectUrl } = await pending;
      const env = await base.stageEnv(request);
      // The remote browser is already running: nothing here launches one, and its allowlist is enforced by the platform.
      for (const key of ["AGENT_BROWSER_ARGS", "AGENT_BROWSER_EXECUTABLE_PATH", "AGENT_BROWSER_ALLOWED_DOMAINS", "AGENT_BROWSER_HEADED"]) delete env[key];
      env.AGENT_BROWSER_CDP = connectUrl;
      return env;
    },
  };
}

/**
 * Saved logins kept by the platform: listing and deleting go to the platform, so clearing a profile removes its cookies there.
 * TODO(multi-tenant): the platform has one profile list per Host; the scope is not sent.
 */
export function createPlatformProfileStore(client: Pick<PlatformBrowserClient, "profiles" | "deleteProfile">): ProfileStore {
  const handles = createVolumeProfileStore();
  return {
    open: (key) => handles.open(key),
    async list(scope) {
      validateProfileScope(scope);
      return (await client.profiles()).sort();
    },
    async delete(rawKey) {
      const key = validateProfileKey(rawKey);
      await client.deleteProfile(key.name);
      await handles.delete(key);
    },
    async deleteScope(scope) {
      for (const name of await this.list(scope)) await this.delete({ scope, name });
    },
  };
}

/** True when the Host env carries both platform settings. */
export function hasPlatformBrowserEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[PLATFORM_URL_ENV]?.trim() && env[PLATFORM_TOKEN_ENV]?.trim());
}

/** The platform host and its profile store from the Host env, or undefined when the platform settings are absent. */
export function platformBrowserSupportFromEnv(env: NodeJS.ProcessEnv, options: { local?: LocalBrowserHostOptions } = {}): { host: BrowserHost; profiles: ProfileStore } | undefined {
  if (!hasPlatformBrowserEnv(env)) return undefined;
  const client = createPlatformBrowserClient({ url: env[PLATFORM_URL_ENV]!.trim(), token: env[PLATFORM_TOKEN_ENV]!.trim() });
  return { host: createPlatformBrowserHost({ client, ...(options.local ? { local: options.local } : {}) }), profiles: createPlatformProfileStore(client) };
}
