import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  type BrowserEnv,
  type BrowserHost,
  type BrowserStageRequest,
  type ProfileBrowserRequest,
  type ProfileBrowserResult,
} from "./browserHost.js";
import { type BrowserEndpointClient, createCdpEndpointClient } from "./containerBrowserEndpoint.js";
import type { BrowserHostCapabilityRecord } from "./hostCapabilities.js";
import { createLocalBrowserHost, type LocalBrowserHostOptions } from "./localBrowserHost.js";

export type AttachBrowserHostOptions = {
  /** Debugging address of the Chrome to attach to (`browser.attach.cdp_url`). */
  cdpUrl: string;
  /** `relay` only when the process also serves the live view routes; default `none`. */
  liveView?: "relay" | "none";
  /** Builds stage session envs (socket dir, session name, config file); defaults to a local host. */
  base?: BrowserHost;
  local?: LocalBrowserHostOptions;
  endpoint?: BrowserEndpointClient;
  /** Resolves a non-IP host to an IPv4 address; Chrome refuses debugging requests addressed by name. */
  resolveHost?: (hostname: string) => Promise<string>;
};

async function defaultResolveHost(hostname: string): Promise<string> {
  return (await lookup(hostname, { family: 4 })).address;
}

/** The user's own Chrome, started and owned by them. This host only attaches to it and never launches or closes it. */
export function createAttachBrowserHost(options: AttachBrowserHostOptions): BrowserHost {
  const client = options.endpoint ?? createCdpEndpointClient();
  const base = options.base ?? createLocalBrowserHost(options.local);
  const resolveHost = options.resolveHost ?? defaultResolveHost;

  async function endpoint(): Promise<string> {
    const url = new URL(options.cdpUrl);
    let host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost") host = "127.0.0.1";
    else if (isIP(host) === 0) host = await resolveHost(host);
    const secure = url.protocol === "wss:" || url.protocol === "https:";
    const printable = isIP(host) === 6 ? `[${host}]` : host;
    return `${secure ? "https" : "http"}://${printable}${url.port !== "" ? `:${url.port}` : ""}`;
  }

  const capabilities: BrowserHostCapabilityRecord = {
    display: "local_window",
    liveView: options.liveView ?? "none",
    attach: "cdp",
    profilePersistence: "none",
    gracefulCloseRequired: false,
  };

  return {
    capabilities,

    async ensureProfileBrowser(request: ProfileBrowserRequest): Promise<ProfileBrowserResult> {
      const address = await client.resolve(await endpoint());
      if (address === undefined) {
        throw new Error(
          `No Chrome answered at ${options.cdpUrl}. Start it with --remote-debugging-port and a dedicated --user-data-dir, then run the stage again.`,
        );
      }
      const env = await base.stageEnv({
        runId: request.runId,
        stageId: `anchor:${request.profile.key.name}`,
        browser: request.browser,
        profile: request.profile,
        cdpAddress: address,
      });
      delete env.AGENT_BROWSER_PIN_TAB;
      return {
        cdpAddress: address,
        anchorEnv: env,
        restarted: request.previous !== undefined && request.previous.cdpAddress !== address,
      };
    },

    async profileBrowserEnv(): Promise<BrowserEnv> {
      throw new Error("the attach browser host has no profile folder; `sf browser login` needs the local host");
    },

    stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      return base.stageEnv(request);
    },
  };
}
