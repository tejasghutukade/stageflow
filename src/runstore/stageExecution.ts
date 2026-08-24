import type { StageEnvelope } from "../types/envelope.js";
import type { StageLogEvent, StageSnapshot } from "./port.js";
import { stageStatusFromEvents } from "./port.js";

export type StageExecutionPatch = {
  status?: StageSnapshot["status"];
  started_at?: string;
  finished_at?: string;
  envelope?: StageEnvelope | null;
};

export function executionStatusFromEvents(
  events: StageLogEvent[],
): StageSnapshot["status"] {
  return stageStatusFromEvents(events);
}

export function deriveExecutionPatchFromEvent(
  event: StageLogEvent,
  current: Pick<StageSnapshot, "status"> & {
    started_at?: string;
    finished_at?: string;
  },
): StageExecutionPatch {
  const patch: StageExecutionPatch = {};
  const eventName = event.event;
  const at = event.at ?? new Date().toISOString();

  if (eventName === "started" || eventName === "resumed") {
    patch.status = "running";
    if (!current.started_at) patch.started_at = at;
  } else if (eventName === "waiting_for_input") {
    patch.status = "waiting_for_input";
  } else if (eventName === "succeeded" || eventName === "failed") {
    patch.status = eventName;
    patch.finished_at = at;
  }
  return patch;
}
