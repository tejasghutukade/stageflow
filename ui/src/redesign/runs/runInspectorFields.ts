import type { PendingPrompt, RunDetail, StageSnapshot } from "../../api";
import { readinessDetail } from "../../track/readinessCopy";

export function pendingGateLabel(prompt: PendingPrompt | undefined): string | null {
  if (!prompt) return null;
  switch (prompt.kind) {
    case "confirm":
      return "confirm gate";
    case "free_text":
      return "free text gate";
    case "multi_question":
      return "multi-question gate";
    case "artifact_backed":
      return "artifact gate";
  }
}

export function stageReadinessLabel(
  run: RunDetail,
  stage: StageSnapshot,
): string | null {
  const node = run.pipeline_track?.nodes.find((n) => n.stage_id === stage.stage_id);
  if (!node) return null;
  return (
    readinessDetail({
      readiness: node.readiness,
      blocked_by: node.blocked_by,
      status: stage.status,
    }) ?? statusReadinessFallback(node.readiness)
  );
}

function statusReadinessFallback(
  readiness: NonNullable<RunDetail["pipeline_track"]>["nodes"][number]["readiness"],
): string {
  switch (readiness) {
    case "blocked":
      return "Blocked";
    case "ready":
      return "Ready";
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "interrupted":
      return "Interrupted";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
  }
}

export function runHasPendingAnswerGate(run: RunDetail): boolean {
  if (!run.waiting_stage_id) return false;
  if (run.waiting_kind === "feedback_loop_decision") return false;
  return true;
}

export function retryBlockedByAnswerGate(run: RunDetail): boolean {
  return runHasPendingAnswerGate(run);
}
