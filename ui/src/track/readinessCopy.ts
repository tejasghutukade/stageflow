import type { StageReadiness, StageSnapshot } from "../api";
import { statusCopy } from "../status/runStatus";
import { waitsOnCopy } from "./waitsOnCopy";

export function readinessDetail(input: {
  readiness: StageReadiness;
  blocked_by?: string[];
  status: StageSnapshot["status"];
  blockersLabel?: (stageId: string) => string;
}): string | undefined {
  const { readiness, blocked_by, status, blockersLabel } = input;

  if (readiness === "blocked") {
    if (blocked_by?.length && blockersLabel) {
      return waitsOnCopy(blocked_by, blockersLabel);
    }
    return blocked_by?.length ? `Blocked on ${blocked_by.join(", ")}` : "Blocked";
  }
  if (readiness === "skipped") return "Skipped";
  if (readiness === "ready") return "Ready";
  if (readiness === "waiting" && status === "waiting_for_input") {
    return undefined;
  }
  if (readiness === "interrupted" && status === "interrupted") {
    return undefined;
  }
  if (readiness === "interrupted") return statusCopy("interrupted");
  if (readiness === "succeeded") return statusCopy("succeeded");
  if (readiness === "failed") return statusCopy("failed");
  if (readiness === "running") return statusCopy("running");
  return undefined;
}
