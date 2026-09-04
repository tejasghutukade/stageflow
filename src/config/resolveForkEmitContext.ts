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
  dag: ResolvedPipelineDag,
  stageId: string,
  options?: ResolveCloneEmitOptions,
): CloneEmitContext | undefined {
  const childIds = dag.childrenOf[stageId] ?? [];
  const clonableSuccessors: CloneEmitContext["clonableSuccessors"] = [];
  for (const childId of childIds) {
    const node = dag.nodes.find((n) => n.id === childId);
    if (node?.clonable === true) {
      const cloneInputSchema = options?.successorCloneInputSchemas?.[childId];
      clonableSuccessors.push({
        successorId: childId,
        cloneCap: node.clone_cap as number,
        ...(cloneInputSchema !== undefined ? { cloneInputSchema } : {}),
      });
    }
  }
  if (clonableSuccessors.length === 0) return undefined;
  return {
    clonableSuccessors,
    ...(options?.allowedActions !== undefined
      ? { allowedActions: options.allowedActions }
      : {}),
  };
}

export function resolveForkEmitContext(
  dag: ResolvedPipelineDag,
  stageId: string,
): ForkEmitContext | undefined {
  const dagNode = dag.nodes.find((n) => n.id === stageId);
  if (!dagNode?.fork) return undefined;
  const immediateSuccessorIds = (dag.childrenOf[stageId] ?? []).filter((childId) => {
    const child = dag.nodes.find((n) => n.id === childId);
    return child?.clonable !== true;
  });
  if (immediateSuccessorIds.length === 0) return undefined;
  return {
    immediateSuccessorIds,
    forkShape: {
      cardinality: dagNode.fork.select,
      allowNone: dagNode.fork.allow_none,
    },
  };
}
