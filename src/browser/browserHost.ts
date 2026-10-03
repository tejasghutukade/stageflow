import { createHash } from "node:crypto";
import type { StageBrowserConfig } from "../types/stage.js";
import type { ProfileLock } from "./profileLock.js";
import type { AuditSink } from "./auditSink.js";
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

/** Runs `agent-browser <args>` with exactly `env` (plus PATH). Injectable for tests. */
export type BrowserRunner = (
  args: string[],
  env: BrowserEnv,
) => Promise<{ code: number | null }>;

export type StageBrowserSupport = {
  host: BrowserHost;
  profiles: ProfileStore;
  runner?: BrowserRunner;
  /** Profile lock; defaults to the local lock-file implementation. */
  locks?: ProfileLock;
  /** Poll interval while a stage waits for a busy profile. */
  lockPollMs?: number;
  /** Upper bound for waiting on the daemon to exit after `close`. */
  closeWaitMs?: number;
  /** Root holding per-session socket dirs; defaults to the local host's root. */
  socketRoot?: string;
  /** Defaults to the local audit log in the Stageflow home. */
  audit?: AuditSink;
  /** Host-blocked sites; defaults to `browser.blocked_sites` from Host config. */
  blockedSites?: readonly string[];
};

export const BROWSER_ENV_PREFIX = "AGENT_BROWSER_";

export function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export const BROWSER_ENV_FILENAME = "browser-env.json";
export const BROWSER_POLICY_FILENAME = "browser-policy.json";
