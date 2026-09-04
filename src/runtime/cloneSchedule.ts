import type { RunPipelineDagSnapshot } from "../runstore/port.js";
import {
  appendCloneInstances,
  instancesOfDefinition,
} from "../runstore/pipelineDagSnapshot.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import { collectDownstreamStageIds } from "./dagTraversal.js";
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

/**
 * A fresh clone_forks fanout targeting a catalog id that already has
 * instances is only safe when every existing instance was put back to
 * `pending` by the current retry cascade (`retryDownstreamIds`) — that means
 * an ancestor was legitimately retried and this parent re-emitted the same
 * fanout for reactivation. Instances that are still active/terminal, or
 * merely `pending` without having gone through a retry reset (e.g. an
 * envelope processed twice in one live run), are rejected as before.
 */
export function cloneFanoutConflict(
  dag: ResolvedPipelineDag,
  envelope: StageEnvelope,
  states: Map<string, StageScheduleState>,
  retryDownstreamIds: ReadonlySet<string>,
): string | undefined {
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
 * Downstream closure for a retry, resolved through clone-instance ids.
 * Catalog-level children (e.g. a join stage) are registered in `childrenOf`
 * under the *definition* id, not per clone instance, so a plain childrenOf
 * walk starting above a fanout dead-ends at the instance ids it discovers
 * transitively (only the initially-given root ids' own definition-id
 * children were resolved before). Resolving at every step, not just the
 * roots, means retrying an ancestor several hops above a clone-fanout parent
 * still reaches the join and everything after it.
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
  } else if (
    // A retried fanout that shrank the clone count marks the now-excess
    // instances "skipped" rather than dangling (see applyCloneForksToSchedule)
    // — a join downstream of the cohort should still proceed once the
    // instances that are actually running have succeeded.
    !instances.every(
      (id) => states.get(id) === "succeeded" || states.get(id) === "skipped",
    )
  ) {
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
    const existing = definitionInstances(current, item.successor_id).filter(
      (id) => id !== item.successor_id,
    );
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
        for (const desc of collectDownstreamStageIds(current, id)) {
          skipPending(desc);
        }
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
