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
  runs(): Promise<string[]>;
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
    async runs() {
      const answer = (await call("GET", "runs")) as { runIds?: unknown } | undefined;
      return Array.isArray(answer?.runIds) ? answer.runIds.filter((id): id is string => typeof id === "string") : [];
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
      // The platform keeps the session alive between stages, so a persisted anchor is still the run's browser.
      if (request.previous !== undefined) return { ...request.previous, restarted: false };
      const { connectUrl } = await client.createSession({ runId: request.runId, profile: request.profile.key.name });
      const env = await base.stageEnv({
        runId: request.runId,
        stageId: `anchor:${request.profile.key.name}`,
        browser: request.browser,
        profile: request.profile,
        cdpAddress: connectUrl,
      });
      delete env.AGENT_BROWSER_PIN_TAB;
      return { cdpAddress: connectUrl, anchorEnv: env, restarted: false };
    },

    async releaseProfileBrowser(request: ProfileBrowserRelease): Promise<void> {
      await client.release({ runId: request.runId, profile: request.profile });
    },

    async releaseStageBrowser(request: StageBrowserRelease): Promise<void> {
      if (request.shared) return;
      await client.release({ runId: request.runId, stageId: request.stageId });
      stageBrowsers.delete(stageKey(request.runId, request.stageId));
    },

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

/** The platform host from the Host env, or undefined when the platform settings are absent. */
export function platformBrowserHostFromEnv(env: NodeJS.ProcessEnv, options: { local?: LocalBrowserHostOptions } = {}): BrowserHost | undefined {
  const url = env[PLATFORM_URL_ENV]?.trim();
  const token = env[PLATFORM_TOKEN_ENV]?.trim();
  if (!url || !token) return undefined;
  return createPlatformBrowserHost({ client: createPlatformBrowserClient({ url, token }), ...(options.local ? { local: options.local } : {}) });
}
