import type { AskOperatorPrompt } from "../tools/askOperator.js";
import { deriveStatusFromStages } from "./port.js";
import type {
  CompactStage,
  RunDetail,
  RunMeta,
  RunPipelineDagSnapshot,
  RunStatus,
  RunSummary,
  StageSnapshot,
} from "./port.js";
import { linearCompatDagSnapshot } from "./pipelineDagSnapshot.js";
import { syntheticPendingSnapshot } from "./syntheticStageSnapshot.js";
import { buildPipelineTrack } from "./trackProjection.js";

export { syntheticPendingSnapshot } from "./syntheticStageSnapshot.js";

export function overlayPlannedStages(
  stageIds: string[],
  snapshots: StageSnapshot[],
): StageSnapshot[] {
  const byId = new Map(snapshots.map((s) => [s.stage_id, s]));
  return stageIds.map((id) => byId.get(id) ?? syntheticPendingSnapshot(id));
}

export function orderStageSnapshots(
  stageIds: string[],
  snapshots: StageSnapshot[],
): StageSnapshot[] {
  return overlayPlannedStages(stageIds, snapshots);
}

function compactStages(stages: StageSnapshot[]): CompactStage[] {
  return stages.map((s) => ({
    id: s.stage_id,
    status: s.status,
    attempt_count: s.attempt_count,
  }));
}

function waitingSummaryFromPrompt(
  prompt: AskOperatorPrompt | undefined,
): string {
  if (!prompt) return "Waiting for input";
  if (prompt.kind === "multi_question") {
    const first = prompt.questions[0]?.message?.trim();
    return first || "Waiting for input";
  }
  const message = prompt.message?.trim();
  return message || "Waiting for input";
}

function waitingFieldsFromStages(
  stages: StageSnapshot[],
): Pick<
  RunSummary,
  | "waiting_stage_id"
  | "waiting_stage_ids"
  | "waiting_summary"
  | "waiting_kind"
  | "waiting_prompt_id"
  | "waiting_artifacts"
  | "waiting_questions"
> {
  const waitingStages = stages.filter((s) => s.status === "waiting_for_input");
  if (waitingStages.length === 0) return {};
  const waiting = waitingStages[0]!;
  const prompt = waiting.pending_prompt;
  const fields: ReturnType<typeof waitingFieldsFromStages> = {
    waiting_stage_id: waiting.stage_id,
    waiting_stage_ids: waitingStages.map((s) => s.stage_id),
    waiting_summary: waitingSummaryFromPrompt(prompt),
  };
  if (prompt) {
    fields.waiting_kind = prompt.kind;
    fields.waiting_prompt_id = prompt.id;
    if (prompt.kind === "artifact_backed") {
      fields.waiting_artifacts = prompt.artifacts;
    }
    if (prompt.kind === "multi_question") {
      fields.waiting_questions = prompt.questions.map((q) => q.message);
    }
  }
  return fields;
}

function failedFieldsFromStages(
  stages: StageSnapshot[],
): Pick<RunSummary, "failed_stage_id" | "failed_reason"> {
  const failed = stages.find((s) => s.status === "failed");
  if (!failed) return {};
  let failed_reason: string | undefined;
  for (const ev of failed.events) {
    if (ev.event === "failed") failed_reason = ev.reason;
  }
  return {
    failed_stage_id: failed.stage_id,
    ...(failed_reason !== undefined ? { failed_reason } : {}),
  };
}

function resolveListedStatus(
  stages: StageSnapshot[],
  meta: RunMeta,
): RunStatus {
  const derived = deriveStatusFromStages(stages);
  return stages.length > 0 ? derived : (meta.status ?? derived);
}

export function projectRunSummary(
  meta: RunMeta,
  stages: StageSnapshot[],
): RunSummary {
  return {
    run_id: meta.run_id,
    pipeline_id: meta.pipeline_id,
    task_id: meta.task_id,
    status: resolveListedStatus(stages, meta),
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    stages: compactStages(stages),
    ...waitingFieldsFromStages(stages),
    ...failedFieldsFromStages(stages),
  };
}

export function projectRunDetail(
  meta: RunMeta,
  stages: StageSnapshot[],
  task_yaml: string,
  dagSnapshot?: RunPipelineDagSnapshot | null,
): RunDetail {
  const ordered = dagSnapshot
    ? overlayPlannedStages(dagSnapshot.stage_ids, stages)
    : stages;
  const summary = projectRunSummary(meta, ordered);
  const snapshot =
    dagSnapshot ??
    linearCompatDagSnapshot(ordered.map((s) => s.stage_id));
  const pipeline_track = buildPipelineTrack({
    dagSnapshot: snapshot,
    stages: ordered,
    runStatus: summary.status,
  });
  return {
    ...summary,
    task_yaml,
    stages: ordered,
    pipeline_track,
  };
}
