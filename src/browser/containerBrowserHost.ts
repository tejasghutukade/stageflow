import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  type BrowserEnv,
  type BrowserHost,
  type BrowserStageRequest,
  type ProfileBrowserRelease,
  type ProfileBrowserRequest,
  type ProfileBrowserResult,
} from "./browserHost.js";
import {
  type BrowserEndpointClient,
  createCdpEndpointClient,
  endpointOf,
} from "./containerBrowserEndpoint.js";
import type { BrowserHostCapabilityRecord } from "./hostCapabilities.js";
import { createLocalBrowserHost, type LocalBrowserHostOptions } from "./localBrowserHost.js";
import type { BrowserSandboxOrchestrator, SandboxInfo } from "./sandboxOrchestrator.js";

export type ContainerBrowserHostOptions = {
  orchestrator: BrowserSandboxOrchestrator;
  /** `relay` only when the process also serves the live view routes; default `none`. */
  liveView?: "relay" | "provider_view" | "none";
  /** Capabilities the orchestrator behind this host adds or overrides (for example a view-only viewer). */
  capabilities?: BrowserHostCapabilityRecord;
  /** Builds stage session envs (socket dir, session name, config file); defaults to a local host. */
  base?: BrowserHost;
  local?: LocalBrowserHostOptions;
  endpoint?: BrowserEndpointClient;
  /** Upper bound for a new container's debugging endpoint to answer. */
  startTimeoutMs?: number;
  /** Upper bound for a graceful browser close to take effect before the orchestrator stops the container. */
  closeWaitMs?: number;
  pollMs?: number;
  /** Resolves a non-IP attach host; Chrome refuses debugging requests addressed by name. */
  resolveHost?: (hostname: string) => Promise<string>;
};

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function defaultResolveHost(hostname: string): Promise<string> {
  return (await lookup(hostname)).address;
}

export function createContainerBrowserHost(options: ContainerBrowserHostOptions): BrowserHost {
  const { orchestrator } = options;
  const client = options.endpoint ?? createCdpEndpointClient();
  const base = options.base ?? createLocalBrowserHost(options.local);
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const closeWaitMs = options.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const resolveHost = options.resolveHost ?? defaultResolveHost;

  async function ipEndpoint(attachAddress: string): Promise<string> {
    const url = new URL(attachAddress);
    let host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost") host = "127.0.0.1";
    else if (isIP(host) === 0) host = await resolveHost(host);
    const secure = url.protocol === "wss:" || url.protocol === "https:";
    const printable = isIP(host) === 6 ? `[${host}]` : host;
    return `${secure ? "https" : "http"}://${printable}${url.port !== "" ? `:${url.port}` : ""}`;
  }

  async function reach(info: SandboxInfo): Promise<string | undefined> {
    if (info.status !== "running" || info.attachAddress === undefined) return undefined;
    return client.resolve(await ipEndpoint(info.attachAddress));
  }

  async function waitFor(done: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await done()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  async function closeAndRelease(info: SandboxInfo): Promise<void> {
    const address = await reach(info).catch(() => undefined);
    if (address !== undefined) {
      await client.closeBrowser(address, closeWaitMs).catch(() => undefined);
      const gone = await waitFor(async () => (await reach(info).catch(() => undefined)) === undefined, closeWaitMs);
      if (!gone) await orchestrator.stopGracefully(info.ref).catch(() => undefined);
    }
    await orchestrator.release(info.ref);
  }

  async function anchorEnvFor(
    request: ProfileBrowserRequest,
    cdpAddress: string,
  ): Promise<BrowserEnv> {
    const env = await base.stageEnv({
      runId: request.runId,
      stageId: `anchor:${request.profile.key.name}`,
      browser: request.browser,
      profile: request.profile,
      cdpAddress,
    });
    delete env.AGENT_BROWSER_PIN_TAB;
    return env;
  }

  const capabilities: BrowserHostCapabilityRecord = {
    display: "virtual_display",
    liveView: options.liveView ?? "none",
    attach: "cdp",
    profilePersistence: "host_volume",
    gracefulCloseRequired: true,
    ...options.capabilities,
  };

  return {
    capabilities,

    async ensureProfileBrowser(request: ProfileBrowserRequest): Promise<ProfileBrowserResult> {
      const { profile, previous } = request;
      const labels = { scope: profile.key.scope, runId: request.runId, profile: profile.key.name };

      if (previous !== undefined) {
        const alive = await client.resolve(endpointOf(previous.cdpAddress)).catch(() => undefined);
        if (alive === previous.cdpAddress) {
          return { cdpAddress: previous.cdpAddress, anchorEnv: previous.anchorEnv, restarted: false };
        }
      }

      let adopted: { address: string; info: SandboxInfo } | undefined;
      for (const info of await orchestrator.listByLabel(labels)) {
        const address = adopted === undefined ? await reach(info).catch(() => undefined) : undefined;
        if (address !== undefined) adopted = { address, info };
        else await closeAndRelease(info).catch(() => undefined);
      }

      let cdpAddress: string;
      if (adopted !== undefined) {
        cdpAddress = adopted.address;
      } else {
        const info = await orchestrator.start({
          labels,
          profile: { scope: profile.key.scope, name: profile.key.name },
        });
        let ready: string | undefined;
        await waitFor(async () => {
          const current = info.attachAddress !== undefined ? info : await orchestrator.inspect(info.ref);
          ready = current !== undefined ? await reach(current).catch(() => undefined) : undefined;
          return ready !== undefined;
        }, startTimeoutMs);
        if (ready === undefined) {
          await orchestrator.release(info.ref).catch(() => undefined);
          throw new Error("the container browser did not answer on its debugging port in time");
        }
        cdpAddress = ready;
      }

      return {
        cdpAddress,
        anchorEnv: await anchorEnvFor(request, cdpAddress),
        restarted: previous !== undefined && previous.cdpAddress !== cdpAddress,
      };
    },

    async releaseProfileBrowser(request: ProfileBrowserRelease): Promise<void> {
      const found = await orchestrator.listByLabel({
        scope: request.scope,
        runId: request.runId,
        profile: request.profile,
      });
      for (const info of found) await closeAndRelease(info);
    },

    async sweepOrphans(input): Promise<{ released: string[] }> {
      const released: string[] = [];
      for (const info of await orchestrator.listByLabel({})) {
        if (await input.isRunLive(info.labels.runId).catch(() => true)) continue;
        await closeAndRelease(info);
        released.push(info.ref.id);
      }
      return { released };
    },

    async profileBrowserEnv(): Promise<BrowserEnv> {
      throw new Error("the container browser host has no profile folder; `sf browser login` needs the local host");
    },

    stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      return base.stageEnv(request);
    },
  };
}
