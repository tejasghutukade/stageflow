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
};

/**
 * Reserved for ticket 03 (loop routing): `{ type: "loop"; to: string; max_replays: ...; ... }`.
 * Declared now so `PipelineRouteEntry` is already the discriminated union ticket 03
 * extends — a forward entry carries no `type` field, so the two stay distinguishable
 * once the loop variant is implemented. Not parsed or resolved by this ticket.
 */
export type PipelineRouteLoopEntry = {
  type: "loop";
  to: string;
};

export type PipelineRouteEntry = PipelineRouteForwardEntry | PipelineRouteLoopEntry;

/** A stage's outbound `route` field: where execution goes next. */
export type PipelineRoute = PipelineRouteEntry[];

/** Normalized forward route edge (post-parse): `on` is always populated. */
export type PipelineRouteEdge = {
  to: string;
  on: RouteTerminalState[];
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
  needs?: string | PipelineNeedItem[];
  fork?: { select: "one" | "subset"; allow_none?: boolean };
  clonable?: boolean;
  clone_cap?: number;
  /** IR: after-phase checks. YAML: `verify` items whose `when` includes `after`. */
  completion?: CompletionContract;
  /** IR: after-phase failure policy. YAML: `on_verify_fail`. */
  recovery?: RecoveryPolicy;
  feedback_loop?: FeedbackLoopConfig;
  /** Omitted means this stage is safe to include in a feedback replay. */
  replay_safe?: boolean;
  /** Additive, alongside `needs`/`fork`/`feedback_loop` (see route-based-pipeline-wiring spec). */
  route?: PipelineRouteEntry[];
  /** Marks this stage as a pipeline entry point. */
  entry?: boolean;
  /**
   * Fork-equivalent selection over this stage's forward `route` entries
   * (ticket 02, route-based-pipeline-wiring spec). Flat sibling of `route`,
   * mirroring today's `fork.select` but requires >=2 forward route entries.
   */
  route_select?: "one" | "subset";
  /** Sibling of `route_select`; mirrors today's `fork.allow_none` (default false). */
  allow_none?: boolean;
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
  needs?: PipelineNeeds;
  fork?: { select: "one" | "subset"; allow_none?: boolean };
  clonable?: boolean;
  clone_cap?: number;
  /** IR after compile. YAML `verify` after-phase / `on_verify_fail`. */
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  feedback_loop?: FeedbackLoopConfig;
  replay_safe?: boolean;
  route?: PipelineRouteEntry[];
  entry?: boolean;
  route_select?: "one" | "subset";
  allow_none?: boolean;
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
