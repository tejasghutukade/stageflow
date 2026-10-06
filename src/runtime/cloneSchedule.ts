import { predecessorEdges } from "../config/pipelineNeeds.js";
import type { RunPipelineDagSnapshot } from "../runstore/port.js";
import {
  appendCloneInstances,
  instancesOfDefinition,
} from "../runstore/pipelineDagSnapshot.js";
import {
  cloneInstanceOrdinal,
  definitionIdForInstance,
} from "../runstore/stageInstanceId.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  NeedTerminalState,
  PipelineNeedEdge,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import { collectDownstreamStageIds } from "./dagTraversal.js";
import type { ResolvePriorEnvelopeResult } from "./envelopeRouting.js";
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

function nextFreeCloneSuffix(
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

function catalogCloneChildId(
  dag: ResolvedPipelineDag,
  emitterId: string,
): string | undefined {
  const catalogChildId = (dag.childrenOf[emitterId] ?? []).find((id) => {
    const child = dag.nodes.find((n) => n.id === id);
    return child !== undefined && (child.definition_id ?? child.id) === child.id;
  });
  if (catalogChildId !== undefined) return catalogChildId;
  const instanceChild = (dag.childrenOf[emitterId] ?? []).find((id) => {
    const child = dag.nodes.find((n) => n.id === id);
    return child?.definition_id !== undefined && child.definition_id !== child.id;
  });
  return instanceChild
    ? dag.nodes.find((n) => n.id === instanceChild)?.definition_id
    : undefined;
}

export type MintResult =
  | { kind: "none" }
  | { kind: "error"; reason: string }
  | {
      kind: "minted";
      dag: RunPipelineDagSnapshot;
      catalogChildId: string;
      instanceIds: string[];
    };

export function mint(
  dag: ResolvedPipelineDag,
  emitterId: string,
  envelope: StageEnvelope,
): MintResult {
  const emitter = dag.nodes.find((n) => n.id === emitterId);
  const field = emitter?.clone_array_field;
  if (field === undefined) return { kind: "none" };
  const catalogChildId = catalogCloneChildId(dag, emitterId);
  if (catalogChildId === undefined) return { kind: "none" };
  const arr = envelope.payload?.[field];
  if (!Array.isArray(arr) || arr.length < 1) {
    return {
      kind: "error",
      reason: `Clone Array "${field}" must contain at least one item`,
    };
  }
  const snapshot = asDagSnapshot(dag);
  const { snapshot: next, instanceIds } = appendCloneInstances(snapshot, {
    catalogId: catalogChildId,
    predecessorId: emitterId,
    count: arr.length,
    startAt: nextFreeCloneSuffix(snapshot, catalogChildId),
  });
  return {
    kind: "minted",
    dag: next,
    catalogChildId,
    instanceIds,
  };
}

function cloneAssignmentIndex(
  dag: ResolvedPipelineDag,
  stageId: string,
  definitionId: string,
  arrayLength: number,
): number | undefined {
  const ordinal = cloneInstanceOrdinal(stageId, definitionId);
  if (ordinal === undefined) return undefined;
  const snapshot = dag as RunPipelineDagSnapshot;
  if (!Array.isArray(snapshot.stage_ids) || arrayLength < 1) {
    return ordinal - 1;
  }
  const siblings = instancesOfDefinition(snapshot, definitionId)
    .map((id) => ({ id, ordinal: cloneInstanceOrdinal(id, definitionId) }))
    .filter((row): row is { id: string; ordinal: number } => row.ordinal !== undefined)
    .sort((a, b) => a.ordinal - b.ordinal);
  const cohort = siblings.slice(-arrayLength);
  const index = cohort.findIndex((row) => row.id === stageId);
  return index === -1 ? undefined : index;
}

export function assignment(
  dag: ResolvedPipelineDag,
  stageId: string,
  definitionId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): ResolvePriorEnvelopeResult | undefined {
  const ordinal = cloneInstanceOrdinal(stageId, definitionId);
  if (ordinal === undefined) return undefined;
  const node = dag.nodes.find((n) => n.id === stageId);
  if (!node) return undefined;
  const emitterId =
    typeof node.needs === "string" && node.needs
      ? node.needs
      : predecessorEdges(node)[0]?.id;
  if (emitterId === undefined) return undefined;
  const emitter = dag.nodes.find((n) => n.id === emitterId);
  const field = emitter?.clone_array_field;
  if (field === undefined) return undefined;
  const parent = completedEnvelopes.get(emitterId);
  if (parent === undefined || parent.status !== "success") {
    return {
      ok: false,
      reason: `missing envelope for Clone Chain emitter "${emitterId}"`,
    };
  }
  const arr = parent.payload?.[field];
  if (!Array.isArray(arr)) {
    return {
      ok: false,
      reason: `missing Clone Array element ${ordinal} on "${emitterId}"`,
    };
  }
  const index = cloneAssignmentIndex(dag, stageId, definitionId, arr.length);
  if (index === undefined || index >= arr.length) {
    return {
      ok: false,
      reason: `missing Clone Array element ${ordinal} on "${emitterId}"`,
    };
  }
  const element = arr[index];
  if (element === null || typeof element !== "object" || Array.isArray(element)) {
    return {
      ok: false,
      reason: `Clone Array element ${index + 1} is not an object`,
    };
  }
  return {
    ok: true,
    prior: {
      status: "success",
      summary: parent.summary,
      artifacts: [],
      payload: structuredClone(element) as Record<string, unknown>,
    },
  };
}

export function protectedClonableChildIds(
  dag: ResolvedPipelineDag,
  predecessorId: string,
  _envelope: StageEnvelope,
): Set<string> {
  const ids = new Set<string>();
  const predecessor = dag.nodes.find((n) => n.id === predecessorId);
  if (predecessor?.clone_array_field === undefined) return ids;
  for (const childId of dag.childrenOf[predecessorId] ?? []) {
    ids.add(childId);
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
): boolean {
  if (definitionInstances(dag, stageId).some((id) => id !== stageId)) {
    return false;
  }
  return !sequentialPreviousUnsatisfied(
    dag,
    stageId,
    states,
    completedEnvelopes,
  );
}
