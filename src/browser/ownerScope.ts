import { LOCAL_BROWSER_SCOPE } from "./profileStore.js";

export type RunOwnerRef = { runId: string };

/** Maps a run to the owner scope its profiles, leases, audit records, sandboxes and live view belong to. */
export type OwnerScopeResolver = (run?: RunOwnerRef) => string;

/** The only resolver today: every run belongs to the single local owner. */
export const localOwnerScope: OwnerScopeResolver = () => LOCAL_BROWSER_SCOPE;

export function runOwnerScope(
  support: { ownerScope?: OwnerScopeResolver },
  run?: RunOwnerRef,
): string {
  return (support.ownerScope ?? localOwnerScope)(run);
}
