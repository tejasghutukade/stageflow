import type { StageSnapshot } from "./port.js";

export function syntheticPendingSnapshot(stageId: string): StageSnapshot {
  return {
    stage_id: stageId,
    status: "pending" as const,
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
  };
}
