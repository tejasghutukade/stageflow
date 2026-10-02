import { createHash } from "node:crypto";
import type { StageBrowserConfig } from "../types/stage.js";
import type { ProfileHandle, ProfileStore } from "./profileStore.js";

export type BrowserEnv = Record<string, string>;

export type BrowserStageRequest = {
  runId: string;
  stageId: string;
  browser: StageBrowserConfig;
  profile?: ProfileHandle;
};

export interface BrowserHost {
  stageEnv(request: BrowserStageRequest): Promise<BrowserEnv>;
}

export type StageBrowserSupport = {
  host: BrowserHost;
  profiles: ProfileStore;
};

export const BROWSER_ENV_PREFIX = "AGENT_BROWSER_";

export function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
