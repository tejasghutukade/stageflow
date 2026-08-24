export type PipelineConfig = {
  id: string;
  stages: string[];
};

export type PipelineStageRef = {
  id: string;
  needs?: string;
};

export type PipelineStageYamlEntry = string | PipelineStageRef;

export type ResolvedPipelineStageNode = {
  id: string;
  needs: string | null;
  ancestors: string[];
  stageIndex: number;
};

export type ResolvedPipelineDag = {
  nodes: ResolvedPipelineStageNode[];
  roots: string[];
  childrenOf: Record<string, string[]>;
};

export type LoadedPipeline = {
  pipeline: PipelineConfig;
  stages: import("./stage.js").StageConfig[];
  dag: ResolvedPipelineDag;
};
