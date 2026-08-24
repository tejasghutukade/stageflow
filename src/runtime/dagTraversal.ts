import type { ResolvedPipelineDag } from "../types/pipeline.js";

export function collectDownstreamStageIds(
  dag: ResolvedPipelineDag,
  rootId: string,
): Set<string> {
  const downstream = new Set<string>();
  const queue = [...(dag.childrenOf[rootId] ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (downstream.has(id)) continue;
    downstream.add(id);
    const children = dag.childrenOf[id];
    if (children) {
      for (const child of children) {
        queue.push(child);
      }
    }
  }
  return downstream;
}

export function collectDownstreamClosure(
  dag: ResolvedPipelineDag,
  rootIds: string[],
): Set<string> {
  const downstream = new Set<string>();
  for (const rootId of rootIds) {
    for (const id of collectDownstreamStageIds(dag, rootId)) {
      downstream.add(id);
    }
  }
  return downstream;
}
