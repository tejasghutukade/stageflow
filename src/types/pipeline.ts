import type { StageConfig, StageGateKind } from "./stage.js";

export type PipelineConfig = {
  id: string;
  stages: string[];
};

export type PipelineForkConfig = {
  select: "one" | "subset";
  allow_none: boolean;
};

export type PipelineStageRef = {
  id: string;
  needs?: string;
  fork?: { select: "one" | "subset"; allow_none?: boolean };
};

export type PipelineStageYamlEntry = PipelineStageRef & {
  uses?: string;
  system_prompt?: string;
  model?: string;
  payload_schema?: unknown;
  gate_kinds?: StageGateKind[];
  skill?: string;
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
  needs?: string;
  fork?: { select: "one" | "subset"; allow_none?: boolean };
  skill?: string;
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
  ancestors: string[];
  stageIndex: number;
  fork?: PipelineForkConfig;
};

export type ResolvedPipelineDag = {
  nodes: ResolvedPipelineStageNode[];
  roots: string[];
  childrenOf: Record<string, string[]>;
};

export type LoadedPipeline = {
  pipeline: PipelineConfig;
  stages: StageConfig[];
  dag: ResolvedPipelineDag;
  pipelinePath: string;
  stageSources?: Record<string, PipelineStageSource>;
};
