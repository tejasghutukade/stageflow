import { isNeedTerminalState, predecessorEdges } from "../config/pipelineNeeds.js";
import type { RunPipelineDagSnapshot } from "../runstore/port.js";
import {
  appendCloneInstances,
  instancesOfDefinition,
} from "../runstore/pipelineDagSnapshot.js";
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

function parentNeedEdge(
  node: Pick<ResolvedPipelineStageNode, "needs" | "needsEdges">,
  parentId: string,
  parentDefId: string,
): PipelineNeedEdge | undefined {
  return predecessorEdges(node).find(
    (edge) => edge.id === parentId || edge.id === parentDefId,
  );
}

function edgeInstancesReady(
  dag: ResolvedPipelineDag,
  edge: PipelineNeedEdge,
  states: Map<string, StageScheduleState>,
): boolean {
  const instances = definitionInstances(dag, edge.id);
  if (instances.length === 0) return false;
  const hasSucceededSibling = instances.some(
    (id) => states.get(id) === "succeeded",
  );
  return instances.every((id) => {
    const state = states.get(id);
    if (!isNeedTerminalState(state)) return false;
    if (edge.on.includes(state)) return true;
    return state === "skipped" && hasSucceededSibling;
  });
}

function shouldSkipForObservedNeed(
  dag: ResolvedPipelineDag,
  node: ResolvedPipelineStageNode,
  parentId: string,
  parentDefId: string,
  observed: NeedTerminalState,
): boolean {
  // A multi-parent (implicit-AND join) node must never be skipped from a
  // single resolving parent in isolation -- that would seal the node's fate
  // before its other predecessors are even known to be terminal. Its
  // disposition is decided only once every predecessor edge is terminal, by
  // `pickStalledJoinSkips` (which reuses `edgeInstancesReady`, the same
  // per-edge check `cloneScheduleAllowsRun` uses on the run path), invoked
  // once per scheduler tick. A single-parent node keeps the original eager
  // behavior below.
  if (predecessorEdges(node).length > 1) return false;
  const edge = parentNeedEdge(node, parentId, parentDefId);
  if (!edge) return false;
  if (edge.on.includes(observed)) return false;
  if (
    observed === "skipped" &&
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

/**
 * A fresh clone_forks fanout targeting a catalog id that already has
 * instances is only safe when every existing instance was put back to
 * `pending` by the current retry cascade (`retryDownstreamIds`) — that means
 * an ancestor was legitimately retried and this parent re-emitted the same
 * fanout for reactivation. Instances that are still active/terminal, or
 * merely `pending` without having gone through a retry reset (e.g. an
 * envelope processed twice in one live run), are rejected as before.
 *
 * Feedback-loop replay is different: the prior cohort was superseded
 * (`skipped`) and a new generation must mint fresh `~N` ids, so
 * `forceFreshCloneIds` bypasses the conflict.
 */
export function cloneFanoutConflict(
  dag: ResolvedPipelineDag,
  envelope: StageEnvelope,
  states: Map<string, StageScheduleState>,
  retryDownstreamIds: ReadonlySet<string>,
  options?: { forceFreshCloneIds?: boolean },
): string | undefined {
  if (options?.forceFreshCloneIds === true) return undefined;
  const snapshot = asDagSnapshot(dag);
  for (const item of envelope.clone_forks ?? []) {
    if (item.action !== "fanout") continue;
    const existing = definitionInstances(dag, item.successor_id).filter(
      (id) => id !== item.successor_id,
    );
    if (existing.length > 0) {
      const reactivatable = existing.every(
        (id) => states.get(id) === "pending" && retryDownstreamIds.has(id),
      );
      if (!reactivatable) {
        return `clone fan-out for "${item.successor_id}" is already instanced`;
      }
      continue;
    }
    if (!snapshot.stage_ids.includes(item.successor_id)) {
      return `clone fan-out for "${item.successor_id}" is already instanced`;
    }
  }
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
    for (const edge of edges) {
      if (!edgeInstancesReady(dag, edge, states)) return false;
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
      )
    ) {
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

/**
 * A multi-parent (implicit-AND join) node whose predecessor edges have ALL
 * reached a terminal state, but which will never satisfy
 * `cloneScheduleAllowsRun` -- terminal states don't change, so once every
 * edge is terminal and at least one still isn't `edgeInstancesReady`, that
 * node is permanently stuck in `pending` unless something explicitly skips
 * it. Deliberately reuses `edgeInstancesReady`, the exact per-edge check the
 * run path (`cloneScheduleAllowsRun`, the `edges.length >= 2` branch above)
 * already applies, so "does this node run" and "does this node get skipped"
 * can't diverge.
 */
function isStalledMultiParentJoin(
  dag: ResolvedPipelineDag,
  node: ResolvedPipelineStageNode,
  states: Map<string, StageScheduleState>,
): boolean {
  const edges = predecessorEdges(node);
  if (edges.length <= 1) return false;
  for (const edge of edges) {
    const instances = definitionInstances(dag, edge.id);
    if (instances.length === 0) return false;
    if (!instances.every((id) => isNeedTerminalState(states.get(id)))) {
      return false;
    }
  }
  return !edges.every((edge) => edgeInstancesReady(dag, edge, states));
}

/**
 * Finds pending multi-parent join nodes whose disposition is now decided
 * (every predecessor edge terminal) but unsatisfiable, so they must be
 * force-skipped. Nothing else ever transitions them out of `pending`
 * otherwise: the positive `cloneScheduleAllowsRun` path never returns true
 * for them once they're stalled, and the single-parent eager skip-cascade in
 * `shouldSkipForObservedNeed` deliberately no longer decides for multi-parent
 * nodes (see its comment). Intended to be called once per scheduler tick,
 * alongside the run-readiness pass.
 */
export function pickStalledJoinSkips(
  dag: ResolvedPipelineDag,
  states: Map<string, StageScheduleState>,
): string[] {
  const ids: string[] = [];
  for (const node of dag.nodes) {
    if (states.get(node.id) !== "pending") continue;
    if (isStalledMultiParentJoin(dag, node, states)) {
      ids.push(node.id);
    }
  }
  return ids;
}

export type ApplyCloneForksResult = {
  dag: RunPipelineDagSnapshot;
  skippedIds: string[];
  /** Freshly minted instance ids keyed by clonable catalog successor id. */
  mintedBySuccessor?: Map<string, string[]>;
};

export function applyCloneForksToSchedule(
  dag: ResolvedPipelineDag,
  predecessorId: string,
  envelope: StageEnvelope,
  states: Map<string, StageScheduleState>,
  options?: { forceFreshCloneIds?: boolean },
): ApplyCloneForksResult {
  let current = asDagSnapshot(dag);
  const skippedIds: string[] = [];
  const mintedBySuccessor = new Map<string, string[]>();
  const forceFresh = options?.forceFreshCloneIds === true;
  const skipPending = (stageId: string) => {
    if (states.get(stageId) === "pending") {
      states.set(stageId, "skipped");
      skippedIds.push(stageId);
    }
  };

  for (const item of envelope.clone_forks ?? []) {
    if (item.action === "skip") {
      skipPending(item.successor_id);
      skipRejectedNeedDependents(
        current,
        item.successor_id,
        states,
        "skipped",
        skipPending,
      );
      continue;
    }
    if (item.action !== "fanout") continue;
    const existing = definitionInstances(current, item.successor_id).filter(
      (id) => id !== item.successor_id,
    );
    if (forceFresh) {
      const { snapshot, instanceIds } = appendCloneInstances(current, {
        catalogId: item.successor_id,
        predecessorId,
        count: item.clones.length,
        startAt: nextFreeCloneSuffix(current, item.successor_id),
      });
      current = snapshot;
      states.delete(item.successor_id);
      for (const id of instanceIds) {
        states.set(id, "pending");
      }
      mintedBySuccessor.set(item.successor_id, instanceIds);
      continue;
    }
    if (existing.length > 0) {
      // Reactivating instances a retry cascade reset to `pending` (see
      // cloneFanoutConflict), which only allows this fanout through when
      // *every* existing instance is pending. Anything short of that —
      // a normal resume re-apply of an already-processed fanout, or only
      // one sibling out of a cohort being retried directly — must stay a
      // no-op here: growing/shrinking the cohort in those cases would mint
      // or skip instances no retry actually asked for.
      const allPending = existing.every((id) => states.get(id) === "pending");
      if (!allPending) continue;
      const desired = item.clones.length;
      for (const id of existing.slice(desired)) {
        skipPending(id);
        skipRejectedNeedDependents(current, id, states, "skipped", skipPending);
      }
      if (desired > existing.length) {
        const { snapshot, instanceIds } = appendCloneInstances(current, {
          catalogId: item.successor_id,
          predecessorId,
          count: desired - existing.length,
          startAt: nextFreeCloneSuffix(current, item.successor_id),
        });
        current = snapshot;
        for (const id of instanceIds) {
          states.set(id, "pending");
        }
      }
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
    mintedBySuccessor.set(item.successor_id, instanceIds);
  }

  return {
    dag: current,
    skippedIds,
    ...(mintedBySuccessor.size > 0 ? { mintedBySuccessor } : {}),
  };
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
