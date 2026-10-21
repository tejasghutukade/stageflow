import { createHash } from "node:crypto";
import type { StageBrowserConfig } from "../types/stage.js";
import type { ProfileLock } from "./profileLock.js";
import type { AuditSink } from "./auditSink.js";
import type { ProfileHandle, ProfileStore } from "./profileStore.js";
import type { BrowserHostCapabilityRecord } from "./hostCapabilities.js";
import type { OwnerScopeResolver } from "./ownerScope.js";

export type BrowserEnv = Record<string, string>;

export type BrowserStageRequest = {
  runId: string;
  stageId: string;
  browser: StageBrowserConfig;
  profile?: ProfileHandle;
  /** A human must see and use this browser; headless fallback does not apply. */
  humanLogin?: boolean;
  /** Required for a stage with a profile: the shared browser's CDP address. */
  cdpAddress?: string;
};

/** The shared browser of one (run, profile): its CDP address and the env that owns it. */
export type ProfileBrowser = {
  cdpAddress: string;
  anchorEnv: BrowserEnv;
};

export type ProfileBrowserRequest = {
  runId: string;
  browser: StageBrowserConfig;
  profile: ProfileHandle;
  humanLogin?: boolean;
  runner: BrowserRunner;
  /** Persisted anchor from an earlier call; reused when still alive, else restarted. */
  previous?: ProfileBrowser;
};

export type ProfileBrowserResult = ProfileBrowser & {
  /** True when a previous anchor existed but its address changed or it was replaced. */
  restarted: boolean;
};

export type ProfileBrowserRelease = {
  scope: string;
  runId: string;
  profile: string;
};

export interface BrowserHost {
  /** What this host can do; read through `resolveBrowserHostCapabilities` so unset fields get safe defaults. */
  readonly capabilities?: BrowserHostCapabilityRecord;
  /**
   * Starts or reuses the one browser for (run, profile) and returns its CDP
   * address. Callers serialize per (run, profile) and persist the result.
   */
  ensureProfileBrowser(request: ProfileBrowserRequest): Promise<ProfileBrowserResult>;
  /**
   * Closes the run's shared browser for a profile gracefully (bounded) and releases
   * what hosts it. Only hosts whose browser lives outside the Host's own sockets implement it.
   */
  releaseProfileBrowser?(request: ProfileBrowserRelease): Promise<void>;
  /** At Host start: releases browsers of runs that are no longer live; returns what it released. */
  sweepOrphans?(input: { isRunLive: (runId: string) => Promise<boolean> }): Promise<{ released: string[] }>;
  /** Env of one stage's agent-browser session; with a profile it attaches to `cdpAddress` in its own tab. */
  stageEnv(request: BrowserStageRequest): Promise<BrowserEnv>;
  /** Env of the session that owns the profile's browser (anchor, or `sf browser login`). */
  profileBrowserEnv(
    request: Omit<BrowserStageRequest, "stageId" | "cdpAddress"> & {
      profile: ProfileHandle;
    },
  ): Promise<BrowserEnv>;
}

/** Runs `agent-browser <args>` with exactly `env` (plus PATH). Injectable for tests. */
export type BrowserRunner = (
  args: string[],
  env: BrowserEnv,
  /** Per-call limit; the default runner allows 20 s. */
  options?: { timeoutMs?: number },
) => Promise<{ code: number | null; stdout?: string }>;

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
  /** Login-check bounds; defaults suit real browsers. */
  loginCheck?: { waitMs?: number; settleMs?: number };
  /** Root holding per-session socket dirs; defaults to the local host's root. */
  socketRoot?: string;
  /** Defaults to the local audit log in the Stageflow home. */
  audit?: AuditSink;
  /** Owner scope of a run; defaults to the fixed local owner. Chosen by the Host, never by YAML. */
  ownerScope?: OwnerScopeResolver;
  /** Host-blocked sites; defaults to `browser.blocked_sites` from Host config. */
  blockedSites?: readonly string[];
  /** Screen detection for human login stages; defaults to the real Host. */
  display?: () => { hasDisplay: boolean; docker: boolean };
  /** Awaited (bounded) before a stage's or run's browser is torn down; stageId absent means the whole run. */
  beforeTeardown?: (input: { runId: string; stageId?: string }) => Promise<void> | void;
  /** Upper bound for `beforeTeardown`; teardown proceeds when it is exceeded. */
  beforeTeardownWaitMs?: number;
};

export const BROWSER_ENV_PREFIX = "AGENT_BROWSER_";

export function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export const BROWSER_ENV_FILENAME = "browser-env.json";
export const BROWSER_POLICY_FILENAME = "browser-policy.json";
