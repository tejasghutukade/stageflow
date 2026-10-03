import { type ProfileKey, validateProfileKey } from "./profileStore.js";

export type ProfileLockOwner = { runId: string; stageId: string };

export type ProfileLockAcquireResult =
  | { status: "acquired"; release(): Promise<void> }
  | { status: "queued"; holder: ProfileLockOwner };

export type RunLiveness = (runId: string) => Promise<boolean>;

export interface ProfileLock {
  /**
   * Re-acquiring as the current holder succeeds again (resumed attempts).
   * A busy profile returns `queued` with the holder; callers retry.
   */
  acquire(
    key: ProfileKey,
    owner: ProfileLockOwner,
  ): Promise<ProfileLockAcquireResult>;
  holder(key: ProfileKey): Promise<ProfileLockOwner | undefined>;
  /** Releases every lock held by this stage, or by the whole run when `stageId` is omitted. */
  releaseOwner(owner: { runId: string; stageId?: string }): Promise<void>;
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
  return a.runId === b.runId && a.stageId === b.stageId;
}

export function lockKey(key: ProfileKey): ProfileKey {
  return validateProfileKey(key);
}

export function ownerMatches(
  held: ProfileLockOwner,
  target: { runId: string; stageId?: string },
): boolean {
  return (
    held.runId === target.runId &&
    (target.stageId === undefined || held.stageId === target.stageId)
  );
}
