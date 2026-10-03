import { createLocalProfileLock } from "./localProfileLock.js";
import type { StageBrowserSupport } from "./browserHost.js";
import type { ProfileLock, ProfileLockOwner, RunLiveness } from "./profileLock.js";
import { LOCAL_BROWSER_SCOPE } from "./profileStore.js";

const DEFAULT_LOCK_POLL_MS = 250;

let defaultLock: ProfileLock | undefined;

export function stageProfileLock(support: StageBrowserSupport): ProfileLock {
  if (support.locks !== undefined) return support.locks;
  defaultLock ??= createLocalProfileLock();
  return defaultLock;
}

export type ProfileWaitInput = {
  profile: string;
  owner: ProfileLockOwner;
  isRunLive?: RunLiveness;
  halted?: () => boolean;
  /** Called when the holder is first seen or changes. */
  onWaiting?: (holder: ProfileLockOwner) => Promise<void> | void;
};

/** Holds the profile for this stage until teardown, waiting for a busy one. */
export async function acquireStageProfile(
  support: StageBrowserSupport,
  input: ProfileWaitInput,
): Promise<"acquired" | "halted"> {
  const locks = stageProfileLock(support);
  const key = { scope: LOCAL_BROWSER_SCOPE, name: input.profile };
  const pollMs = support.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  let announced: ProfileLockOwner | undefined;
  for (;;) {
    const result = await locks.acquire(key, input.owner);
    if (result.status === "acquired") return "acquired";
    if (input.halted?.()) return "halted";
    if (
      announced === undefined ||
      announced.runId !== result.holder.runId ||
      announced.stageId !== result.holder.stageId
    ) {
      announced = result.holder;
      await input.onWaiting?.(result.holder);
    }
    if (input.isRunLive !== undefined) {
      await locks.reclaimStale(input.isRunLive).catch(() => 0);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function profileWaitingMessage(
  profile: string,
  holder: ProfileLockOwner,
): string {
  return `waiting for browser profile "${profile}" held by run ${holder.runId} stage ${holder.stageId}`;
}
