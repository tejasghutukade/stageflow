import { type ProfileKey, validateProfileKey } from "./profileStore.js";

/**
 * A profile is leased to a run. `stageId` is informational (the stage that
 * first took the lease) and never part of identity.
 */
export type ProfileLockOwner = { runId: string; stageId?: string };

export type ProfileLockAcquireResult =
  | { status: "acquired"; release(): Promise<void> }
  | { status: "queued"; holder: ProfileLockOwner };

export type RunLiveness = (runId: string) => Promise<boolean>;

export interface ProfileLock {
  /**
   * Any stage of the holder run joins the lease and succeeds at once. A
   * profile leased to another run returns `queued` with the holder; callers retry.
   */
  acquire(
    key: ProfileKey,
    owner: ProfileLockOwner,
  ): Promise<ProfileLockAcquireResult>;
  holder(key: ProfileKey): Promise<ProfileLockOwner | undefined>;
  /** Releases every lease held by this run (run end, cancel, abandon, failure). */
  releaseOwner(owner: { runId: string }): Promise<void>;
  /** Drops locks whose holder run is no longer live; returns the count dropped. */
  reclaimStale(isRunLive: RunLiveness): Promise<number>;
}

export type ProfileLockOptions = {
  /** When set, `acquire` reclaims a lock whose holder run is not live. */
  isRunLive?: RunLiveness;
};

export function sameOwner(
  a: ProfileLockOwner,
  b: ProfileLockOwner,
): boolean {
  return a.runId === b.runId;
}

export function lockKey(key: ProfileKey): ProfileKey {
  return validateProfileKey(key);
}

export function ownerMatches(
  held: ProfileLockOwner,
  target: { runId: string },
): boolean {
  return held.runId === target.runId;
}
