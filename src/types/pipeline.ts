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

export type RouteIfOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in";

export type RouteIfLeafPredicate = {
  field: string;
  op: RouteIfOp;
  value: unknown;
};

export type RouteIfAllPredicate = {
  all: RouteIfPredicate[];
  field?: never;
};

export type RouteIfAnyPredicate = {
  any: RouteIfPredicate[];
  field?: never;
};

export type RouteIfNotPredicate = {
  not: RouteIfPredicate;
  field?: never;
};

export type RouteIfPredicate =
  | RouteIfLeafPredicate
  | RouteIfAllPredicate
  | RouteIfAnyPredicate
  | RouteIfNotPredicate;

export type PipelineNeedEdge = {
  id: string;
  on: NeedTerminalState[];
  if?: RouteIfPredicate;
};

export type PipelineNeedItem = string | { id: string; on?: NeedTerminalState[] };

export type PipelineNeeds = string | PipelineNeedEdge[];

/**
 * Terminal states a route entry (or its inverted predecessor edge) can gate on.
 * Same domain as `NeedTerminalState` — kept as a distinct alias since `route`
 * is a separate vocabulary from `needs` (see docs/specs/route-based-pipeline-wiring.md).
 */
export type RouteTerminalState = NeedTerminalState;

/**
 * A forward route entry: hands off from the declaring stage to `to`, gated on
 * the declaring stage's own terminal state (`on`, defaulting to succeeded-only).
 */
export type PipelineRouteForwardEntry = {
  to: string;
  on?: RouteTerminalState | RouteTerminalState[];
  if?: RouteIfPredicate;
};

/**
 * A loop route entry (ticket 03, route-based-pipeline-wiring spec): sends
 * execution back to a declared ancestor of the source stage instead of
 * continuing forward, carrying the same replay policy `FeedbackLoopConfig`
 * carries today — `target` renamed to `to` for naming consistency with
 * forward entries. Contributes no forward DAG edge (`toRouteEdges` skips
 * it), so it is excluded from cycle detection; it is a runtime-only replay
 * schedule over the already-resolved forward graph.
 */
export type PipelineRouteLoopEntry = {
  type: "loop";
  to: string;
  max_replays: number;
  on_max_replays: "require_continue" | "wait_for_human";
  replay_session: "resume" | "new_session";
};

export type PipelineRouteEntry = PipelineRouteForwardEntry | PipelineRouteLoopEntry;

/** A stage's outbound `route` field: where execution goes next. */
export type PipelineRoute = PipelineRouteEntry[];

/** Normalized forward route edge (post-parse): `on` is always populated. */
export type PipelineRouteEdge = {
  to: string;
  on: RouteTerminalState[];
  if?: RouteIfPredicate;
};

/** Runtime feedback-loop policy declared by the stage that can send work back. */
export type FeedbackLoopConfig = {
  target: string;
  max_replays: number;
  on_max_replays: "require_continue" | "wait_for_human";
  replay_session: "resume" | "new_session";
};

export type PipelineStageRef = {
  id: string;
  clonable?: boolean;
  clone_cap?: number;
  /** IR: after-phase checks. YAML: `verify` items whose `when` includes `after`. */
  completion?: CompletionContract;
  /** IR: after-phase failure policy. YAML: `on_verify_fail`. */
  recovery?: RecoveryPolicy;
  /** Omitted means this stage is safe to include in a feedback replay. */
  replay_safe?: boolean;
  /** Pipeline wiring vocabulary (see route-based-pipeline-wiring spec). */
  route?: PipelineRouteEntry[];
  /** Marks this stage as a pipeline entry point. */
  entry?: boolean;
};

/**
 * Pipeline YAML stage entry (both dialects). Target authoring is `io` / `verify`
 * / `on_verify_fail`. The payload_schema / pre_emit_checks / completion /
 * recovery keys are the legacy YAML dialect (and also the IR names after compile).
 * New catalog fields: add target YAML keys here and compile them in yamlDialect.ts.
 */
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
  clonable?: boolean;
  clone_cap?: number;
  /** IR after compile. YAML `verify` after-phase / `on_verify_fail`. */
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  replay_safe?: boolean;
  route?: PipelineRouteEntry[];
  entry?: boolean;
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
  /** Persisted on pipeline_dag. YAML `verify` after-phase. */
  completion?: CompletionContract;
  /** Persisted on pipeline_dag. YAML `on_verify_fail`. */
  recovery?: RecoveryPolicy;
  feedback_loop?: FeedbackLoopConfig;
  replay_safe?: boolean;
  /** Present (true) only when this stage was declared `entry: true`. */
  entry?: boolean;
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
