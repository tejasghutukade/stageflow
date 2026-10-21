import {
  type ProfileLock,
  type ProfileLockOptions,
  type ProfileLockOwner,
  type RunLiveness,
  lockKey,
  ownerMatches,
  sameOwner,
} from "./profileLock.js";
import type { ProfileKey } from "./profileStore.js";

export function createInMemoryProfileLock(
  options: ProfileLockOptions = {},
): ProfileLock {
  const held = new Map<string, ProfileLockOwner>();
  const id = (key: ProfileKey) => `${key.scope}\u0000${key.name}`;

  const releaseIfHeldBy = (k: string, owner: ProfileLockOwner) => {
    const current = held.get(k);
    if (current !== undefined && sameOwner(current, owner)) held.delete(k);
  };

  return {
    async acquire(rawKey, owner) {
      const key = lockKey(rawKey);
      const k = id(key);
      let current = held.get(k);
      if (
        current !== undefined &&
        !sameOwner(current, owner) &&
        options.isRunLive !== undefined &&
        !(await options.isRunLive(current.runId))
      ) {
        held.delete(k);
        current = undefined;
      }
      if (current !== undefined && !sameOwner(current, owner)) {
        return { status: "queued", holder: { ...current } };
      }
      if (current === undefined) held.set(k, { ...owner });
      return {
        status: "acquired",
        release: async () => releaseIfHeldBy(k, owner),
      };
    },

    async holder(rawKey) {
      const current = held.get(id(lockKey(rawKey)));
      return current === undefined ? undefined : { ...current };
    },

    async releaseOwner(target) {
      for (const [k, owner] of [...held]) {
        if (ownerMatches(owner, target)) held.delete(k);
      }
    },

    async reclaimStale(isRunLive: RunLiveness) {
      let dropped = 0;
      for (const [k, owner] of [...held]) {
        if (!(await isRunLive(owner.runId))) {
          held.delete(k);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}
