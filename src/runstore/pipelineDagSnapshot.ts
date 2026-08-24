import type { LoadedPipeline, ResolvedPipelineStageNode } from "../types/pipeline.js";
import type { StageGateKind } from "../types/stage.js";
import type { RunPipelineDagSnapshot } from "./port.js";

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
    nodes: loaded.dag.nodes,
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
