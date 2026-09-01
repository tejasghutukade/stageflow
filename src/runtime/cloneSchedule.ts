import type { RunPipelineDagSnapshot } from "../runstore/port.js";
import {
  appendCloneInstances,
  instancesOfDefinition,
} from "../runstore/pipelineDagSnapshot.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import { collectDownstreamClosure, collectDownstreamStageIds } from "./dagTraversal.js";
import type { StageScheduleState } from "./pipelineScheduler.js";

function asDagSnapshot(dag: ResolvedPipelineDag): RunPipelineDagSnapshot {
  const snapshot = dag as RunPipelineDagSnapshot;
  if (Array.isArray(snapshot.stage_ids)) return snapshot;
  return {
    ...dag,
    stage_ids: dag.nodes.map((n) => n.id),
  };
}

function definitionInstances(
  dag: ResolvedPipelineDag,
  catalogId: string,
): string[] {
  const snapshot = dag as RunPipelineDagSnapshot;
  if (Array.isArray(snapshot.stage_ids)) {
    return instancesOfDefinition(snapshot, catalogId);
  }
  return dag.nodes.some((n) => n.id === catalogId) ? [catalogId] : [];
}

export function isCloneInstance(
  dag: ResolvedPipelineDag,
  stageId: string,
): boolean {
  return definitionIdForInstance(asDagSnapshot(dag), stageId) !== stageId;
}

function isParallelCloneInstance(
  dag: ResolvedPipelineDag,
  stageId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  if (!isCloneInstance(dag, stageId)) return false;
  const defId = definitionIdForInstance(asDagSnapshot(dag), stageId);
  for (const envelope of completedEnvelopes.values()) {
    for (const item of envelope.clone_forks ?? []) {
      if (
        item.action === "fanout" &&
        item.mode === "parallel" &&
        item.successor_id === defId &&
        definitionInstances(dag, defId).includes(stageId)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isSequentialFanoutSuccessor(
  completedEnvelopes: Map<string, StageEnvelope>,
  successorId: string,
): boolean {
  for (const envelope of completedEnvelopes.values()) {
    for (const item of envelope.clone_forks ?? []) {
      if (
        item.action === "fanout" &&
        item.mode === "sequential" &&
        item.successor_id === successorId
      ) {
        return true;
      }
    }
  }
  return false;
}

function isSequentialCloneInstance(
  dag: ResolvedPipelineDag,
  stageId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  if (!isCloneInstance(dag, stageId)) return false;
  const defId = definitionIdForInstance(asDagSnapshot(dag), stageId);
  if (!isSequentialFanoutSuccessor(completedEnvelopes, defId)) return false;
  return definitionInstances(dag, defId).includes(stageId);
}

function sequentialInstanceList(
  dag: ResolvedPipelineDag,
  stageId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): string[] | undefined {
  for (const envelope of completedEnvelopes.values()) {
    for (const item of envelope.clone_forks ?? []) {
      if (item.action !== "fanout" || item.mode !== "sequential") continue;
      const instances = definitionInstances(dag, item.successor_id);
      if (instances.includes(stageId)) return instances;
    }
  }
  return undefined;
}

function sequentialPreviousUnsatisfied(
  dag: ResolvedPipelineDag,
  stageId: string,
  states: Map<string, StageScheduleState>,
  completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  const instances = sequentialInstanceList(dag, stageId, completedEnvelopes);
  if (instances === undefined) return false;
  const i = instances.indexOf(stageId);
  if (i <= 0) return false;
  return states.get(instances[i - 1]!) !== "succeeded";
}

export function sequentialLaterCloneIds(
  dag: ResolvedPipelineDag,
  stageId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): string[] {
  const instances = sequentialInstanceList(dag, stageId, completedEnvelopes);
  if (instances === undefined) return [];
  const i = instances.indexOf(stageId);
  if (i === -1) return [];
  return instances.slice(i + 1);
}

function joinSuccessorIds(
  dag: ResolvedPipelineDag,
  successorId: string,
): string[] {
  return dag.nodes.filter((n) => n.needs === successorId).map((n) => n.id);
}

function joinAndDownstreamIds(
  dag: ResolvedPipelineDag,
  cloneStageId: string,
): string[] {
  const defId = definitionIdForInstance(asDagSnapshot(dag), cloneStageId);
  const ids: string[] = [];
  for (const joinId of joinSuccessorIds(dag, defId)) {
    ids.push(joinId);
    for (const desc of collectDownstreamStageIds(dag, joinId)) {
      ids.push(desc);
    }
  }
  return ids;
}

export function cloneFanoutConflict(
  dag: ResolvedPipelineDag,
  envelope: StageEnvelope,
): string | undefined {
  const snapshot = asDagSnapshot(dag);
  for (const item of envelope.clone_forks ?? []) {
    if (item.action !== "fanout") continue;
    if (definitionInstances(dag, item.successor_id).some((id) => id !== item.successor_id)) {
      return `clone fan-out for "${item.successor_id}" is already instanced`;
    }
    if (!snapshot.stage_ids.includes(item.successor_id)) {
      return `clone fan-out for "${item.successor_id}" is already instanced`;
    }
  }
  return undefined;
}

export function protectedClonableChildIds(
  dag: ResolvedPipelineDag,
  predecessorId: string,
  envelope: StageEnvelope,
): Set<string> {
  const ids = new Set<string>();
  for (const childId of dag.childrenOf[predecessorId] ?? []) {
    const child = dag.nodes.find((n) => n.id === childId);
    if (child?.clonable === true) ids.add(childId);
  }
  for (const item of envelope.clone_forks ?? []) {
    ids.add(item.successor_id);
  }
  return ids;
}

export function cloneRetryDownstream(
  dag: ResolvedPipelineDag,
  stageIds: string[],
): Set<string> {
  const downstream = collectDownstreamClosure(dag, stageIds);
  for (const id of stageIds) {
    const defId = definitionIdForInstance(asDagSnapshot(dag), id);
    for (const child of dag.childrenOf[defId] ?? []) {
      downstream.add(child);
      for (const desc of collectDownstreamStageIds(dag, child)) {
        downstream.add(desc);
      }
    }
  }
  return downstream;
}

export function cloneFailureContinuesSchedule(
  dag: ResolvedPipelineDag,
  stageId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  return (
    isParallelCloneInstance(dag, stageId, completedEnvelopes) ||
    isSequentialCloneInstance(dag, stageId, completedEnvelopes)
  );
}

export function cloneFailFastSkipIds(
  dag: ResolvedPipelineDag,
  stageId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): string[] {
  if (isParallelCloneInstance(dag, stageId, completedEnvelopes)) {
    return joinAndDownstreamIds(dag, stageId);
  }
  if (!isSequentialCloneInstance(dag, stageId, completedEnvelopes)) return [];
  const instances = sequentialInstanceList(dag, stageId, completedEnvelopes);
  if (instances === undefined) return [];
  const idx = instances.indexOf(stageId);
  const ids: string[] = [];
  for (const id of instances.slice(idx + 1)) {
    ids.push(id);
  }
  ids.push(...joinAndDownstreamIds(dag, stageId));
  return ids;
}

export function cloneScheduleAllowsRun(
  dag: ResolvedPipelineDag,
  stageId: string,
  states: Map<string, StageScheduleState>,
  completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  const node = dag.nodes.find((n) => n.id === stageId);
  if (!node) return false;
  if (definitionInstances(dag, stageId).some((id) => id !== stageId)) {
    return false;
  }
  if (node.needs === null) {
    return !sequentialPreviousUnsatisfied(
      dag,
      stageId,
      states,
      completedEnvelopes,
    );
  }
  const instances = definitionInstances(dag, node.needs);
  if (instances.length <= 1) {
    const parentId = instances[0] ?? node.needs;
    if (states.get(parentId) !== "succeeded") return false;
  } else if (!instances.every((id) => states.get(id) === "succeeded")) {
    return false;
  }
  return !sequentialPreviousUnsatisfied(
    dag,
    stageId,
    states,
    completedEnvelopes,
  );
}

export type ApplyCloneForksResult = {
  dag: RunPipelineDagSnapshot;
  skippedIds: string[];
};

export function applyCloneForksToSchedule(
  dag: ResolvedPipelineDag,
  predecessorId: string,
  envelope: StageEnvelope,
  states: Map<string, StageScheduleState>,
): ApplyCloneForksResult {
  let current = asDagSnapshot(dag);
  const skippedIds: string[] = [];
  const skipPending = (stageId: string) => {
    if (states.get(stageId) === "pending") {
      states.set(stageId, "skipped");
      skippedIds.push(stageId);
    }
  };

  for (const item of envelope.clone_forks ?? []) {
    if (item.action === "skip") {
      skipPending(item.successor_id);
      for (const desc of collectDownstreamStageIds(current, item.successor_id)) {
        skipPending(desc);
      }
      continue;
    }
    if (item.action !== "fanout") continue;
    const existing = definitionInstances(current, item.successor_id);
    if (existing.some((id) => id !== item.successor_id)) {
      continue;
    }
    const { snapshot, instanceIds } = appendCloneInstances(current, {
      catalogId: item.successor_id,
      predecessorId,
      count: item.clones.length,
    });
    current = snapshot;
    states.delete(item.successor_id);
    for (const id of instanceIds) {
      states.set(id, "pending");
    }
  }

  return { dag: current, skippedIds };
}

export function applyCloneForksFromEnvelopes(
  dag: ResolvedPipelineDag,
  states: Map<string, StageScheduleState>,
  completedEnvelopes: Map<string, StageEnvelope>,
): ApplyCloneForksResult {
  let current = asDagSnapshot(dag);
  const skippedIds: string[] = [];
  const predecessors = [...current.nodes];
  for (const node of predecessors) {
    const envelope = completedEnvelopes.get(node.id);
    if (!envelope?.clone_forks?.length) continue;
    const applied = applyCloneForksToSchedule(
      current,
      node.id,
      envelope,
      states,
    );
    current = applied.dag;
    skippedIds.push(...applied.skippedIds);
  }
  return { dag: current, skippedIds };
}
