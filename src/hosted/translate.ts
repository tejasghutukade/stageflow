import type { StageActivityEvent, StageLogLine } from "../agent/activity.js";
import { redactString } from "../logging/redact.js";
import type { HostedEventBody } from "./types.js";

const ACTIVITY_EVENTS = new Set<StageActivityEvent["event"]>([
  "agent_start",
  "agent_end",
  "turn_start",
  "tool_start",
  "tool_end",
  "tool_progress",
  "message",
  "operator_prompt",
  "operator_answer",
]);

function redactActivity(event: StageActivityEvent): StageActivityEvent {
  return JSON.parse(redactString(JSON.stringify(event))) as StageActivityEvent;
}

export function translateStageEvent(
  stageId: string,
  event: StageLogLine,
  attempt: number,
): HostedEventBody | undefined {
  if (ACTIVITY_EVENTS.has(event.event as StageActivityEvent["event"])) {
    return {
      type: "stage.activity",
      stageId,
      attempt,
      activity: redactActivity(event as StageActivityEvent),
    };
  }
  switch (event.event) {
    case "started":
      return { type: "stage.started", stageId, attempt };
    case "waiting_for_input":
      return { type: "stage.waiting", stageId, attempt };
    case "succeeded":
      return { type: "stage.succeeded", stageId, attempt };
    case "failed":
    case "interrupted":
      return {
        type: "stage.failed",
        stageId,
        attempt,
        reason: redactString(event.reason),
      };
    default:
      return undefined;
  }
}
