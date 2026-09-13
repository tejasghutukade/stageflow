import type {
  CloneAction,
  CloneEmitContext,
  ForkEmitContext,
} from "../types/forkChoice.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";

export type ResolveCloneEmitOptions = {
  allowedActions?: CloneAction[];
  successorCloneInputSchemas?: Record<string, unknown>;
};

export function resolveCloneEmitContext(
  _dag: ResolvedPipelineDag,
  _stageId: string,
  _options?: ResolveCloneEmitOptions,
): CloneEmitContext | undefined {
  return undefined;
}

export function resolveForkEmitContext(
  dag: ResolvedPipelineDag,
  stageId: string,
): ForkEmitContext | undefined {
  const dagNode = dag.nodes.find((n) => n.id === stageId);
  if (!dagNode?.fork) return undefined;
  const immediateSuccessorIds = dag.childrenOf[stageId] ?? [];
  if (immediateSuccessorIds.length === 0) return undefined;
  return {
    immediateSuccessorIds,
    forkShape: {
      cardinality: dagNode.fork.select,
      allowNone: dagNode.fork.allow_none,
    },
  };
}
