import type { StageReadiness, StageSnapshot } from "../api";
import { statusCopy } from "../status/runStatus";

export function readinessDetail(input: {
  readiness: StageReadiness;
  blocked_by?: string[];
  status: StageSnapshot["status"];
}): string | undefined {
  const { readiness, blocked_by, status } = input;

  if (readiness === "blocked") {
    const blocker = blocked_by?.[0];
    return blocker ? `Blocked on ${blocker}` : "Blocked";
  }
  if (readiness === "skipped") return "Skipped";
  if (readiness === "ready") return "Ready";
  if (readiness === "waiting" && status === "waiting_for_input") {
    return undefined;
  }
  if (readiness === "succeeded") return statusCopy("succeeded");
  if (readiness === "failed") return statusCopy("failed");
  if (readiness === "running") return statusCopy("running");
  return undefined;
}
