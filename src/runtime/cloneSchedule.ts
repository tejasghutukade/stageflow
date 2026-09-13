import { predecessorEdges } from "../config/pipelineNeeds.js";
import type { RunPipelineDagSnapshot } from "../runstore/port.js";
import { instancesOfDefinition } from "../runstore/pipelineDagSnapshot.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  NeedTerminalState,
  PipelineNeedEdge,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import { collectDownstreamStageIds } from "./dagTraversal.js";
import {
  activeCohortFromCloneIds,
  filterJoinInputs,
  type ActiveCohort,
} from "./forkGeneration.js";
import {
  inboundEdgeFired,
  joinAllowsRun,
} from "./joinReadiness.js";
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

function emitterCloneMode(
  dag: ResolvedPipelineDag,
  stageId: string,
): ResolvedPipelineStageNode["clone_mode"] {
  if (!isCloneInstance(dag, stageId)) return undefined;
  const node = dag.nodes.find((n) => n.id === stageId);
  const emitterId =
    typeof node?.needs === "string" && node.needs ? node.needs : undefined;
  if (emitterId === undefined) return undefined;
  return dag.nodes.find((n) => n.id === emitterId)?.clone_mode;
}

function isParallelCloneInstance(
  dag: ResolvedPipelineDag,
  stageId: string,
  _completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  return emitterCloneMode(dag, stageId) === "parallel";
}

function isSequentialCloneInstance(
  dag: ResolvedPipelineDag,
  stageId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  return sequentialInstanceList(dag, stageId, completedEnvelopes) !== undefined;
}

function sequentialInstanceList(
  dag: ResolvedPipelineDag,
  stageId: string,
  _completedEnvelopes: Map<string, StageEnvelope>,
): string[] | undefined {
  if (!isCloneInstance(dag, stageId)) return undefined;
  const snapshot = asDagSnapshot(dag);
  const defId = definitionIdForInstance(snapshot, stageId);
  const node = dag.nodes.find((n) => n.id === stageId);
  const emitterId =
    typeof node?.needs === "string" && node.needs ? node.needs : undefined;
  if (emitterId === undefined) return undefined;
  const emitter = dag.nodes.find((n) => n.id === emitterId);
  if (emitter?.clone_mode !== "sequential") return undefined;
  return definitionInstances(dag, defId);
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

function parentNeedEdge(
  node: Pick<ResolvedPipelineStageNode, "needs" | "needsEdges">,
  parentId: string,
  parentDefId: string,
): PipelineNeedEdge | undefined {
  return predecessorEdges(node).find(
    (edge) => edge.id === parentId || edge.id === parentDefId,
  );
}

function shouldSkipForObservedNeed(
  dag: ResolvedPipelineDag,
  node: ResolvedPipelineStageNode,
  parentId: string,
  parentDefId: string,
  observed: NeedTerminalState,
): boolean {
  // A multi-parent join is never skip-cascaded from one parent. Once every
  // parent is terminal: run if any succeeded (skipped siblings do not
  // block) unless every parent succeeded and an inbound `if` missed;
  // stay pending if any failed; force-skip when every parent is skipped
  // or every parent succeeded with an inbound miss (`pickStalledJoinSkips`).
  // A single-parent node keeps eager skip-cascade below.
  if (predecessorEdges(node).length > 1) return false;
  const edge = parentNeedEdge(node, parentId, parentDefId);
  if (!edge) return false;
  if (edge.on.includes(observed)) return false;
  if (
    (observed === "skipped" || observed === "failed") &&
    predecessorEdges(node).length === 1 &&
    typeof node.needs === "string" &&
    isCloneInstance(dag, parentId)
  ) {
    return false;
  }
  return true;
}

export function skipRejectedNeedDependents(
  dag: ResolvedPipelineDag,
  parentId: string,
  states: Map<string, StageScheduleState>,
  observed: NeedTerminalState,
  onSkip: (stageId: string) => void,
): void {
  const parentDefId = definitionIdForInstance(asDagSnapshot(dag), parentId);
  for (const node of dag.nodes) {
    if (states.get(node.id) !== "pending") continue;
    if (!shouldSkipForObservedNeed(dag, node, parentId, parentDefId, observed)) {
      continue;
    }
    onSkip(node.id);
    skipRejectedNeedDependents(dag, node.id, states, "skipped", onSkip);
  }
}

export function failureIsAccepted(
  dag: ResolvedPipelineDag,
  failedId: string,
  states: Map<string, StageScheduleState>,
): boolean {
  const defId = definitionIdForInstance(asDagSnapshot(dag), failedId);
  for (const node of dag.nodes) {
    const edge = parentNeedEdge(node, failedId, defId);
    if (!edge?.on.includes("failed")) continue;
    const state = states.get(node.id);
    if (state !== undefined && state !== "skipped") return true;
  }
  return false;
}

function joinSuccessorIds(
  dag: ResolvedPipelineDag,
  successorId: string,
): string[] {
  return dag.nodes
    .filter((n) => predecessorEdges(n).some((edge) => edge.id === successorId))
    .map((n) => n.id);
}

function joinAndDownstreamIds(
  dag: ResolvedPipelineDag,
  cloneStageId: string,
): string[] {
  const defId = definitionIdForInstance(asDagSnapshot(dag), cloneStageId);
  const ids: string[] = [];
  for (const joinId of joinSuccessorIds(dag, defId)) {
    const node = dag.nodes.find((n) => n.id === joinId);
    if (
      node &&
      !shouldSkipForObservedNeed(dag, node, cloneStageId, defId, "failed")
    ) {
      continue;
    }
    ids.push(joinId);
    for (const desc of collectDownstreamStageIds(dag, joinId)) {
      ids.push(desc);
    }
  }
  return ids;
}

export function cloneFanoutConflict(
  _dag: ResolvedPipelineDag,
  _envelope: StageEnvelope,
  _states: Map<string, StageScheduleState>,
  _retryDownstreamIds: ReadonlySet<string>,
  _options?: { forceFreshCloneIds?: boolean },
): string | undefined {
  return undefined;
}

export function nextFreeCloneSuffix(
  snapshot: RunPipelineDagSnapshot,
  catalogId: string,
): number {
  const prefix = `${catalogId}~`;
  let max = 0;
  for (const id of snapshot.stage_ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

export function protectedClonableChildIds(
  dag: ResolvedPipelineDag,
  predecessorId: string,
  _envelope: StageEnvelope,
): Set<string> {
  const ids = new Set<string>();
  for (const childId of dag.childrenOf[predecessorId] ?? []) {
    const child = dag.nodes.find((n) => n.id === childId);
    if (child?.clonable === true) ids.add(childId);
  }
  return ids;
}

/**
 * Downstream closure for a retry, resolved through clone-instance ids and
 * static multi-parent edges. Catalog-level children (e.g. a join stage) are
 * registered in `childrenOf` under the *definition* id, not per clone
 * instance, so a plain childrenOf walk starting above a fanout dead-ends at
 * the instance ids it discovers transitively. Resolving definition-id
 * children and `predecessorEdges` join successors at every step means
 * retrying an ancestor or a single clone instance still reaches the join
 * and everything after it, without pulling in sibling terminals.
 */
export function cloneRetryDownstream(
  dag: ResolvedPipelineDag,
  stageIds: string[],
): Set<string> {
  const snapshot = asDagSnapshot(dag);
  const downstream = new Set<string>();
  const seeds = new Set(stageIds);
  const queue = [...stageIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const defId = definitionIdForInstance(snapshot, id);
    const children = new Set<string>([
      ...(dag.childrenOf[id] ?? []),
      ...(defId !== id ? dag.childrenOf[defId] ?? [] : []),
      ...joinSuccessorIds(dag, id),
      ...(defId !== id ? joinSuccessorIds(dag, defId) : []),
    ]);
    for (const child of children) {
      if (downstream.has(child) || seeds.has(child)) continue;
      downstream.add(child);
      queue.push(child);
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
  options?: {
    activeCohortForNeeds?: (needsId: string) => ActiveCohort;
    activeCloneIdsForNeeds?: (needsId: string) => Set<string> | null;
  },
): boolean {
  const node = dag.nodes.find((n) => n.id === stageId);
  if (!node) return false;
  if (definitionInstances(dag, stageId).some((id) => id !== stageId)) {
    return false;
  }
  const edges = predecessorEdges(node);
  if (edges.length === 0) {
    return !sequentialPreviousUnsatisfied(
      dag,
      stageId,
      states,
      completedEnvelopes,
    );
  }
  if (edges.length >= 2) {
    if (!joinAllowsRun(dag, stageId, states, completedEnvelopes)) {
      return false;
    }
  } else {
    const parentNeedId =
      typeof node.needs === "string" && node.needs ? node.needs : edges[0]!.id;
    const allInstances = definitionInstances(dag, parentNeedId);
    const cohort =
      options?.activeCohortForNeeds?.(parentNeedId) ??
      activeCohortFromCloneIds(options?.activeCloneIdsForNeeds?.(parentNeedId));
    if (cohort.kind === "awaiting_mint") {
      return false;
    }
    const instances = filterJoinInputs(allInstances, cohort);
    if (instances.length <= 1) {
      const parentId = instances[0] ?? parentNeedId;
      if (states.get(parentId) !== "succeeded") return false;
    } else if (cohort.kind === "active") {
      if (!instances.every((id) => states.get(id) === "succeeded")) {
        return false;
      }
    } else if (
      !instances.every(
        (id) => states.get(id) === "succeeded" || states.get(id) === "skipped",
      ) ||
      !instances.some((id) => states.get(id) === "succeeded")
    ) {
      return false;
    }
  }
  if (edges.length === 1 && edges[0]!.if !== undefined) {
    const parentNeedId =
      typeof node.needs === "string" && node.needs ? node.needs : edges[0]!.id;
    const parentId = definitionInstances(dag, parentNeedId)[0] ?? parentNeedId;
    if (!inboundEdgeFired(edges[0]!, parentId, states, completedEnvelopes)) {
      return false;
    }
  }
  return !sequentialPreviousUnsatisfied(
    dag,
    stageId,
    states,
    completedEnvelopes,
  );
}
