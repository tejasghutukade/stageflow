import type { RunDetail, StageSnapshot } from "../runstore/port.js";
import type {
  PipelineTrackProjection,
  RunSummary,
} from "../runstore/port.js";
import type { AskOperatorPrompt } from "../tools/askOperator.js";
import type { StageEnvelope } from "../types/envelope.js";

export type StageProjection = {
  stage_id: string;
  status: StageSnapshot["status"];
  envelope: {
    status: StageEnvelope["status"];
    summary: string;
    artifacts: string[];
    payload?: Record<string, unknown>;
    fork_choice?: string[];
  } | null;
  artifacts: string[];
  last_at?: string;
  pending_prompt?: AskOperatorPrompt;
};

export type RunProjection = {
  run_id: string;
  pipeline_id: string;
  task_id?: string;
  pipeline_path?: string;
  task_path?: string;
  project_root?: string;
  status: RunDetail["status"];
  created_at: string;
  updated_at?: string;
  stages: StageProjection[];
  pipeline_track: PipelineTrackProjection;
  waiting_stage_id?: RunSummary["waiting_stage_id"];
  waiting_stage_ids?: RunSummary["waiting_stage_ids"];
  waiting_summary?: RunSummary["waiting_summary"];
  waiting_kind?: RunSummary["waiting_kind"];
  waiting_prompt_id?: RunSummary["waiting_prompt_id"];
  waiting_artifacts?: RunSummary["waiting_artifacts"];
  waiting_questions?: RunSummary["waiting_questions"];
  failed_stage_id?: RunSummary["failed_stage_id"];
  failed_reason?: RunSummary["failed_reason"];
};

export function projectRun(detail: RunDetail): RunProjection {
  return {
    run_id: detail.run_id,
    pipeline_id: detail.pipeline_id,
    task_id: detail.task_id,
    ...(detail.pipeline_path !== undefined
      ? { pipeline_path: detail.pipeline_path }
      : {}),
    ...(detail.task_path !== undefined ? { task_path: detail.task_path } : {}),
    ...(detail.project_root !== undefined
      ? { project_root: detail.project_root }
      : {}),
    status: detail.status,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    pipeline_track: detail.pipeline_track,
    ...(detail.waiting_stage_id !== undefined
      ? { waiting_stage_id: detail.waiting_stage_id }
      : {}),
    ...(detail.waiting_stage_ids !== undefined
      ? { waiting_stage_ids: detail.waiting_stage_ids }
      : {}),
    ...(detail.waiting_summary !== undefined
      ? { waiting_summary: detail.waiting_summary }
      : {}),
    ...(detail.waiting_kind !== undefined
      ? { waiting_kind: detail.waiting_kind }
      : {}),
    ...(detail.waiting_prompt_id !== undefined
      ? { waiting_prompt_id: detail.waiting_prompt_id }
      : {}),
    ...(detail.waiting_artifacts !== undefined
      ? { waiting_artifacts: detail.waiting_artifacts }
      : {}),
    ...(detail.waiting_questions !== undefined
      ? { waiting_questions: detail.waiting_questions }
      : {}),
    ...(detail.failed_stage_id !== undefined
      ? { failed_stage_id: detail.failed_stage_id }
      : {}),
    ...(detail.failed_reason !== undefined
      ? { failed_reason: detail.failed_reason }
      : {}),
    stages: detail.stages.map((stage) => ({
      stage_id: stage.stage_id,
      status: stage.status,
      envelope: stage.envelope
        ? {
            status: stage.envelope.status,
            summary: stage.envelope.summary,
            artifacts: stage.envelope.artifacts,
            ...(stage.envelope.payload !== undefined
              ? { payload: stage.envelope.payload }
              : {}),
            ...(stage.envelope.fork_choice !== undefined
              ? { fork_choice: stage.envelope.fork_choice }
              : {}),
          }
        : null,
      artifacts: stage.artifacts,
      last_at: stage.last_at,
      ...(stage.pending_prompt
        ? { pending_prompt: stage.pending_prompt }
        : {}),
    })),
  };
}

export { projectRun as projectRunForMcp };
