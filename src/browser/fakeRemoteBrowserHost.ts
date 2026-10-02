import {
  type BrowserEnv,
  type BrowserHost,
  type BrowserStageRequest,
  shortHash,
} from "./browserHost.js";

export function createFakeRemoteBrowserHost(address: string): BrowserHost {
  return {
    async stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      const identity = request.profile
        ? `${request.profile.key.scope}/${request.profile.key.name}`
        : `${request.runId}/${request.stageId}`;
      return {
        AGENT_BROWSER_CDP: address,
        AGENT_BROWSER_SESSION: `sf-r-${shortHash(identity, 12)}`,
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      };
    },
  };
}
