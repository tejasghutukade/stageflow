import {
  type BrowserEnv,
  type BrowserHost,
  type BrowserStageRequest,
  type ProfileBrowserRequest,
  type ProfileBrowserResult,
  shortHash,
} from "./browserHost.js";
import type { BrowserHostCapabilityRecord } from "./hostCapabilities.js";

export function createFakeRemoteBrowserHost(
  address: string,
  capabilities: BrowserHostCapabilityRecord = { attach: "cdp" },
): BrowserHost {
  return {
    capabilities,

    async ensureProfileBrowser(
      request: ProfileBrowserRequest,
    ): Promise<ProfileBrowserResult> {
      return {
        cdpAddress: address,
        anchorEnv: {
          AGENT_BROWSER_CDP: address,
          AGENT_BROWSER_SESSION: `sf-r-${shortHash(`${request.profile.key.scope}/${request.profile.key.name}`, 12)}`,
          AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
        },
        restarted: false,
      };
    },

    async profileBrowserEnv(request): Promise<BrowserEnv> {
      return {
        AGENT_BROWSER_CDP: address,
        AGENT_BROWSER_SESSION: `sf-r-${shortHash(`${request.profile.key.scope}/${request.profile.key.name}`, 12)}`,
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      };
    },

    async stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      const identity = `${request.runId}/${request.stageId}`;
      const env: BrowserEnv = {
        AGENT_BROWSER_CDP: request.cdpAddress ?? address,
        AGENT_BROWSER_SESSION: `sf-r-${shortHash(identity, 12)}`,
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      };
      if (request.profile !== undefined) env.AGENT_BROWSER_PIN_TAB = "1";
      return env;
    },
  };
}
