import type { ForkEmitContext } from "../types/forkChoice.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";

export function resolveForkEmitContext(
  dag: ResolvedPipelineDag,
  stageId: string,
): ForkEmitContext | undefined {
  const dagNode = dag.nodes.find((n) => n.id === stageId);
  if (!dagNode?.fork) return undefined;
  return {
    immediateSuccessorIds: dag.childrenOf[stageId] ?? [],
    forkShape: {
      cardinality: dagNode.fork.select,
      allowNone: dagNode.fork.allow_none,
    },
  };
}
