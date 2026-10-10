import { readPersistedAnchor } from "./anchor.js";
import type { LiveViewSessionRequest } from "./liveViewRelay.js";
import { readStagePersistedBrowserEnv } from "./stageBrowserEnv.js";

/**
 * Rebuilds a relay request from what the Host persisted (the stage env and, for a
 * stage with a profile, the run's anchor), so a live view survives a Host restart.
 */
export async function readLiveViewSessionRequest(input: {
  runDir: string;
  runId: string;
  stageId: string;
  profile?: string;
}): Promise<LiveViewSessionRequest | undefined> {
  const env = await readStagePersistedBrowserEnv(input.runDir, input.stageId);
  if (env === undefined) return undefined;
  const anchor =
    input.profile !== undefined
      ? await readPersistedAnchor(input.runDir, input.profile)
      : undefined;
  return {
    runId: input.runId,
    stageId: input.stageId,
    env,
    ...(anchor !== undefined
      ? { anchorEnv: anchor.anchorEnv, cdpAddress: anchor.cdpAddress }
      : {}),
  };
}
