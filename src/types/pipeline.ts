import type { CloneAction } from "./forkChoice.js";
import type { LoadedStageConfig, StageGateKind, StageIoYaml } from "./stage.js";
import type { CompletionContract, RecoveryPolicy } from "./completion.js";

export type PipelineConfig = {
  id: string;
  stages: string[];
  /** Selects the AgentPort backend for every stage in this pipeline; overrides the global default. */
  agent?: string;
  /** Default LLM model id for every stage in this pipeline; overrides the global default. */
  model?: string;
  /** Pipeline-file `$ref` root (`#/schemas/<name>`). */
  schemas?: Record<string, unknown>;
};

export type PipelineForkConfig = {
  select: "one" | "subset";
  allow_none: boolean;
};

export type NeedTerminalState = "succeeded" | "failed" | "skipped";

export type PipelineNeedEdge = {
  id: string;
  on: NeedTerminalState[];
};

export type PipelineNeedItem = string | { id: string; on?: NeedTerminalState[] };

export type PipelineNeeds = string | PipelineNeedEdge[];

/** Runtime feedback-loop policy declared by the stage that can send work back. */
export type FeedbackLoopConfig = {
  target: string;
  max_replays: number;
  on_max_replays: "require_continue" | "wait_for_human";
  replay_session: "resume" | "new_session";
};

export type PipelineStageRef = {
  id: string;
  needs?: string | PipelineNeedItem[];
  fork?: { select: "one" | "subset"; allow_none?: boolean };
  clonable?: boolean;
  clone_cap?: number;
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  feedback_loop?: FeedbackLoopConfig;
  /** Omitted means this stage is safe to include in a feedback replay. */
  replay_safe?: boolean;
};

export type PipelineStageYamlEntry = PipelineStageRef & {
  uses?: string;
  system_prompt?: string;
  model?: string;
  payload_schema?: unknown;
  gate_kinds?: StageGateKind[];
  clone_input_schema?: unknown;
  clone_actions?: CloneAction[];
  skill?: string;
  mcp?: string[];
  io?: StageIoYaml;
  verify?: unknown;
  on_verify_fail?: RecoveryPolicy;
  pre_emit_checks?: unknown;
};

export type PipelineIncludeEntry = {
  local: string;
};

export type PipelineFragmentConfig = {
  include?: PipelineIncludeEntry[];
  stages?: PipelineStageYamlEntry[];
};

export type NormalizedPipelineStageEntry = {
  id: string;
  needs?: PipelineNeeds;
  fork?: { select: "one" | "subset"; allow_none?: boolean };
  clonable?: boolean;
  clone_cap?: number;
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  feedback_loop?: FeedbackLoopConfig;
  replay_safe?: boolean;
  skill?: string;
  mcp?: string[];
  body:
    | { kind: "inline"; raw: Record<string, unknown> }
    | { kind: "uses"; path: string; absolutePath: string };
  declaringPath: string;
};

export type PipelineStageSource =
  | { kind: "inline" }
  | { kind: "file"; path: string };

export type ResolvedPipelineStageNode = {
  id: string;
  needs: string | null;
  needsEdges: PipelineNeedEdge[];
  ancestors: string[];
  stageIndex: number;
  fork?: PipelineForkConfig;
  clonable?: boolean;
  clone_cap?: number;
  definition_id?: string;
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  feedback_loop?: FeedbackLoopConfig;
  replay_safe?: boolean;
};

export type ResolvedPipelineDag = {
  nodes: ResolvedPipelineStageNode[];
  roots: string[];
  childrenOf: Record<string, string[]>;
};

export type LoadedPipeline = {
  pipeline: PipelineConfig;
  stages: LoadedStageConfig[];
  dag: ResolvedPipelineDag;
  pipelinePath: string;
  stageSources?: Record<string, PipelineStageSource>;
};
