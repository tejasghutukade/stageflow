import type { LoadedPipeline, ResolvedPipelineStageNode } from "../types/pipeline.js";
import type { StageGateKind } from "../types/stage.js";
import type { RunPipelineDagSnapshot } from "./port.js";
import { mintCloneInstanceIds } from "./stageInstanceId.js";

export function buildPipelineDagSnapshotFromLoaded(
  loaded: LoadedPipeline,
): RunPipelineDagSnapshot {
  const gate_kinds: Record<string, StageGateKind[]> = {};
  for (const stage of loaded.stages) {
    if (stage.gate_kinds?.length) {
      gate_kinds[stage.id] = stage.gate_kinds;
    }
  }
  return {
    stage_ids: [...loaded.pipeline.stages],
    nodes: loaded.dag.nodes.map((node) => ({
      ...node,
      definition_id: node.id,
    })),
    roots: loaded.dag.roots,
    childrenOf: loaded.dag.childrenOf,
    ...(Object.keys(gate_kinds).length > 0 ? { gate_kinds } : {}),
  };
}

export function linearCompatDagSnapshot(stageIds: string[]): RunPipelineDagSnapshot {
  const nodes: ResolvedPipelineStageNode[] = stageIds.map((id, index) => ({
    id,
    needs: index === 0 ? null : stageIds[index - 1]!,
    ancestors: index === 0 ? [] : stageIds.slice(0, index),
    stageIndex: index,
    definition_id: id,
  }));
  const childrenOf: Record<string, string[]> = {};
  for (let i = 1; i < stageIds.length; i++) {
    const parent = stageIds[i - 1]!;
    const child = stageIds[i]!;
    childrenOf[parent] = [...(childrenOf[parent] ?? []), child];
  }
  return {
    stage_ids: [...stageIds],
    nodes,
    roots: stageIds.length > 0 ? [stageIds[0]!] : [],
    childrenOf,
  };
}

export function parsePipelineDagSnapshot(raw: unknown): RunPipelineDagSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.stage_ids) || !Array.isArray(value.nodes)) return null;
  return raw as RunPipelineDagSnapshot;
}

export function instancesOfDefinition(
  snapshot: RunPipelineDagSnapshot,
  catalogId: string,
): string[] {
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  return snapshot.stage_ids.filter((id) => {
    const node = nodeById.get(id);
    return (node?.definition_id ?? node?.id) === catalogId;
  });
}

export function appendCloneInstances(
  snapshot: RunPipelineDagSnapshot,
  input: { catalogId: string; predecessorId: string; count: number },
): { snapshot: RunPipelineDagSnapshot; instanceIds: string[] } {
  const { catalogId, predecessorId, count } = input;
  if (!snapshot.stage_ids.includes(catalogId)) {
    throw new Error(
      `catalog stage "${catalogId}" is not in the run DAG snapshot`,
    );
  }
  const predNode = snapshot.nodes.find((n) => n.id === predecessorId);
  if (!predNode) {
    throw new Error(
      `predecessor "${predecessorId}" is not in the run DAG snapshot`,
    );
  }
  const instanceIds = mintCloneInstanceIds(catalogId, count);
  for (const id of instanceIds) {
    if (
      snapshot.stage_ids.includes(id) ||
      snapshot.nodes.some((n) => n.id === id)
    ) {
      throw new Error(
        `instance id "${id}" already exists in the run DAG snapshot`,
      );
    }
  }
  const catalogNode = snapshot.nodes.find((n) => n.id === catalogId);
  if (!catalogNode) {
    throw new Error(
      `catalog stage "${catalogId}" is not in the run DAG snapshot`,
    );
  }

  const catalogIdx = snapshot.stage_ids.indexOf(catalogId);
  const stage_ids = [
    ...snapshot.stage_ids.slice(0, catalogIdx),
    ...instanceIds,
    ...snapshot.stage_ids.slice(catalogIdx + 1),
  ];

  const instanceNodes: ResolvedPipelineStageNode[] = instanceIds.map((id) => ({
    id,
    definition_id: catalogId,
    needs: predecessorId,
    ancestors: [...predNode.ancestors, predecessorId],
    stageIndex: 0,
    ...(catalogNode.fork !== undefined ? { fork: catalogNode.fork } : {}),
    ...(catalogNode.completion !== undefined
      ? { completion: catalogNode.completion }
      : {}),
    ...(catalogNode.recovery !== undefined
      ? { recovery: catalogNode.recovery }
      : {}),
  }));

  const remaining = new Map(
    snapshot.nodes
      .filter((n) => n.id !== catalogId)
      .map((n) => [n.id, n] as const),
  );
  const minted = new Map(instanceNodes.map((n) => [n.id, n] as const));
  const nodes = stage_ids.map((id, index) => {
    const node = minted.get(id) ?? remaining.get(id);
    if (!node) {
      throw new Error(`missing node for "${id}" after clone fan-out`);
    }
    return { ...node, stageIndex: index };
  });

  const childrenOf: Record<string, string[]> = {};
  for (const [key, children] of Object.entries(snapshot.childrenOf)) {
    childrenOf[key] = [...children];
  }

  const predChildren = childrenOf[predecessorId] ?? [];
  const predIdx = predChildren.indexOf(catalogId);
  childrenOf[predecessorId] =
    predIdx === -1
      ? [...predChildren, ...instanceIds]
      : [
          ...predChildren.slice(0, predIdx),
          ...instanceIds,
          ...predChildren.slice(predIdx + 1),
        ];

  const definitionParent = catalogNode.needs;
  if (definitionParent && definitionParent !== predecessorId) {
    const parentChildren = childrenOf[definitionParent] ?? [];
    childrenOf[definitionParent] = parentChildren.filter((id) => id !== catalogId);
    if (childrenOf[definitionParent].length === 0) {
      delete childrenOf[definitionParent];
    }
  }

  return {
    snapshot: {
      ...snapshot,
      stage_ids,
      nodes,
      childrenOf,
    },
    instanceIds,
  };
}
