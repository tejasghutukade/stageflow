import type {
  CloneMode,
  FeedbackLoopConfig,
  LoadedPipeline,
  PipelineForkConfig,
  PipelineNeedEdge,
  ResolvedPipelineStageNode,
  RouteIfPredicate,
} from "../types/pipeline.js";
import type { StageGateKind } from "../types/stage.js";
import { toPipelineNeeds } from "./pipelineNeeds.js";

export type PipelineDescribeNeedEdge = {
  id: string;
  on: PipelineNeedEdge["on"];
  if?: RouteIfPredicate;
};

export type PipelineDescribeNeeds = string | null | PipelineDescribeNeedEdge[];

export type PipelineDescribeStage = {
  id: string;
  needs: PipelineDescribeNeeds;
  fork?: PipelineForkConfig;
  gate_kinds?: StageGateKind[];
  clone_cap?: number;
  clone_mode?: CloneMode;
  feedback_loop?: FeedbackLoopConfig;
  entry?: boolean;
  replay_safe?: boolean;
};

export type PipelineDescribe = {
  id: string;
  path: string;
  stages: PipelineDescribeStage[];
};

export function describePipelineNeeds(
  node: ResolvedPipelineStageNode,
): PipelineDescribeNeeds {
  if (node.needsEdges.length === 0) return node.needs;
  const collapsed = toPipelineNeeds(node.needsEdges);
  if (typeof collapsed === "string") return collapsed;
  return collapsed.map((edge) => ({
    id: edge.id,
    on: [...edge.on],
    ...(edge.if !== undefined ? { if: edge.if } : {}),
  }));
}

export function describePipeline(loaded: LoadedPipeline): PipelineDescribe {
  const gateById = new Map(
    loaded.stages.map((stage) => [stage.id, stage.gate_kinds] as const),
  );
  const stages = loaded.dag.nodes.map((node) => {
    const gateKinds = gateById.get(node.id);
    return {
      id: node.id,
      needs: describePipelineNeeds(node),
      ...(node.fork !== undefined ? { fork: { ...node.fork } } : {}),
      ...(node.clone_cap !== undefined ? { clone_cap: node.clone_cap } : {}),
      ...(node.clone_mode !== undefined ? { clone_mode: node.clone_mode } : {}),
      ...(node.feedback_loop !== undefined
        ? { feedback_loop: { ...node.feedback_loop } }
        : {}),
      ...(node.entry !== undefined ? { entry: node.entry } : {}),
      ...(node.replay_safe !== undefined ? { replay_safe: node.replay_safe } : {}),
      ...(gateKinds !== undefined ? { gate_kinds: [...gateKinds] } : {}),
    };
  });
  return {
    id: loaded.pipeline.id,
    path: loaded.pipelinePath,
    stages,
  };
}
