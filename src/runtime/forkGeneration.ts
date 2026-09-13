import { randomUUID } from "node:crypto";
import type {
  ForkGenerationRecord,
  RunPipelineDagSnapshot,
  RunStore,
} from "../runstore/port.js";
import { instancesOfDefinition } from "../runstore/pipelineDagSnapshot.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import { collectDownstreamStageIds } from "./dagTraversal.js";

function asDagSnapshot(dag: ResolvedPipelineDag): RunPipelineDagSnapshot {
  const snapshot = dag as RunPipelineDagSnapshot;
  if (Array.isArray(snapshot.stage_ids)) return snapshot;
  return {
    ...dag,
    stage_ids: dag.nodes.map((n) => n.id),
  };
}

function nodeById(dag: ResolvedPipelineDag, id: string) {
  return dag.nodes.find((n) => n.id === id);
}

function isCloneEmitter(
  node: { clone_array_field?: string } | undefined,
): boolean {
  return node?.clone_array_field !== undefined;
}

function isMintedCloneInstance(
  node: { id: string; definition_id?: string } | undefined,
): boolean {
  return (
    node !== undefined &&
    node.definition_id !== undefined &&
    node.definition_id !== node.id
  );
}

function parentIsCloneEmitter(
  dag: ResolvedPipelineDag,
  node: { needs: string | null } | undefined,
): boolean {
  if (node?.needs === null || node?.needs === undefined) return false;
  return isCloneEmitter(nodeById(dag, node.needs));
}

/** Persistent route stages that fan out to Clone Chain children (or already have instances). */
export function routeRelatedForkParentIds(
  dag: ResolvedPipelineDag,
  routeStageIds: readonly string[],
): string[] {
  const routeSet = new Set(routeStageIds);
  const parents = new Set<string>();
  const snapshot = asDagSnapshot(dag);

  for (const stageId of routeStageIds) {
    if (isCloneEmitter(nodeById(dag, stageId))) {
      parents.add(stageId);
    }
  }

  for (const stageId of routeStageIds) {
    const node = nodeById(dag, stageId);
    if (node !== undefined && parentIsCloneEmitter(dag, node) && node.needs !== null) {
      parents.add(node.needs);
    }
  }

  for (const node of dag.nodes) {
    const defId = node.definition_id;
    if (defId === undefined || defId === node.id) continue;
    if (node.needs !== null && routeSet.has(node.needs)) {
      parents.add(node.needs);
    }
  }

  for (const stageId of routeStageIds) {
    const node = nodeById(dag, stageId);
    if (!parentIsCloneEmitter(dag, node) || isMintedCloneInstance(node)) continue;
    const instances = instancesOfDefinition(snapshot, stageId).filter(
      (id) => id !== stageId,
    );
    if (instances.length > 0 && node !== undefined && node.needs !== null) {
      parents.add(node.needs);
    }
  }

  return [...parents];
}

/** Clone instance ids currently under Clone Chain children of a fork parent. */
export function cloneInstanceIdsForForkParent(
  dag: ResolvedPipelineDag,
  forkParentStageId: string,
): string[] {
  const snapshot = asDagSnapshot(dag);
  const ids: string[] = [];
  const seen = new Set<string>();
  const parentIsEmitter = isCloneEmitter(nodeById(dag, forkParentStageId));
  for (const childId of dag.childrenOf[forkParentStageId] ?? []) {
    const child = nodeById(dag, childId);
    if (parentIsEmitter && !isMintedCloneInstance(child)) {
      for (const id of instancesOfDefinition(snapshot, childId)) {
        if (id === childId) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      continue;
    }
    if (
      child?.definition_id !== undefined &&
      child.definition_id !== child.id &&
      !seen.has(childId)
    ) {
      seen.add(childId);
      ids.push(childId);
    }
  }
  for (const node of dag.nodes) {
    if (node.needs !== forkParentStageId) continue;
    if (node.definition_id === undefined || node.definition_id === node.id) {
      continue;
    }
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    ids.push(node.id);
  }
  return ids;
}

export async function backfillActiveGenerationIfNeeded(
  store: RunStore,
  runId: string,
  options: {
    dag: ResolvedPipelineDag;
    forkParentStageId: string;
  },
): Promise<ForkGenerationRecord | undefined> {
  const { dag, forkParentStageId } = options;
  const existing = await store.listForkGenerations(runId, {
    forkParentStageId,
  });
  if (existing.some((g) => g.status === "active")) {
    return existing.find((g) => g.status === "active");
  }
  const cloneStageIds = cloneInstanceIdsForForkParent(dag, forkParentStageId);
  if (cloneStageIds.length === 0) return undefined;
  const maxNumber = existing.reduce(
    (max, g) => Math.max(max, g.generation_number),
    0,
  );
  return store.createForkGeneration(runId, {
    generation_id: randomUUID(),
    fork_parent_stage_id: forkParentStageId,
    generation_number: maxNumber + 1,
    clone_stage_ids: cloneStageIds,
    status: "active",
  });
}

export type ActiveCohort =
  | { kind: "untracked" }
  | { kind: "awaiting_mint" }
  | { kind: "active"; cloneIds: ReadonlySet<string> };

export function activeCohortFromCloneIds(
  activeCloneIds: Set<string> | ReadonlySet<string> | null | undefined,
): ActiveCohort {
  if (activeCloneIds === undefined || activeCloneIds === null) {
    return { kind: "untracked" };
  }
  if (activeCloneIds.size === 0) return { kind: "awaiting_mint" };
  return { kind: "active", cloneIds: activeCloneIds };
}

export function cloneIdsFromActiveCohort(
  cohort: ActiveCohort,
): Set<string> | null {
  if (cohort.kind === "untracked") return null;
  if (cohort.kind === "awaiting_mint") return new Set();
  return new Set(cohort.cloneIds);
}

/** Resolve the fork parent that fans out into instances of `needsStageId`. */
export function forkParentForNeedsStage(
  dag: ResolvedPipelineDag,
  needsStageId: string,
): string | null {
  const snapshot = asDagSnapshot(dag);
  const instances = Array.isArray(snapshot.stage_ids)
    ? instancesOfDefinition(snapshot, needsStageId).filter(
        (id) => id !== needsStageId,
      )
    : [];
  if (instances.length === 0) return null;
  const sample = dag.nodes.find((n) => n.id === instances[0]);
  const forkParentId = sample?.needs;
  if (forkParentId === undefined || forkParentId === null) return null;
  return forkParentId;
}

export async function supersedeActiveGenerations(
  store: RunStore,
  runId: string,
  options: {
    dag: ResolvedPipelineDag;
    forkParentStageIds: readonly string[];
  },
): Promise<{
  supersededCloneIds: Set<string>;
  supersededGenerations: ForkGenerationRecord[];
}> {
  const supersededCloneIds = new Set<string>();
  const supersededGenerations: ForkGenerationRecord[] = [];

  for (const forkParentStageId of options.forkParentStageIds) {
    await backfillActiveGenerationIfNeeded(store, runId, {
      dag: options.dag,
      forkParentStageId,
    });
    const gens = await store.listForkGenerations(runId, { forkParentStageId });
    for (const gen of gens) {
      if (gen.status !== "active") continue;
      await store.updateForkGeneration(runId, gen.generation_id, {
        status: "superseded",
      });
      supersededGenerations.push({ ...gen, status: "superseded" });
      for (const id of gen.clone_stage_ids) {
        supersededCloneIds.add(id);
      }
    }
  }

  return { supersededCloneIds, supersededGenerations };
}

export async function retireCohortsForRoute(options: {
  store: RunStore;
  runId: string;
  dag: ResolvedPipelineDag;
  routeStageIds: readonly string[];
}): Promise<{
  supersededCloneIds: ReadonlySet<string>;
  forkParentIds: string[];
}> {
  const forkParentIds = routeRelatedForkParentIds(
    options.dag,
    options.routeStageIds,
  );
  const { supersededCloneIds } = await supersedeActiveGenerations(
    options.store,
    options.runId,
    {
      dag: options.dag,
      forkParentStageIds: forkParentIds,
    },
  );
  return { supersededCloneIds, forkParentIds };
}

export async function collectSupersededCloneIdsForRoute(options: {
  store: RunStore;
  runId: string;
  dag: ResolvedPipelineDag;
  routeStageIds: readonly string[];
}): Promise<ReadonlySet<string>> {
  const forkParentIds = routeRelatedForkParentIds(
    options.dag,
    options.routeStageIds,
  );
  const supersededCloneIds = new Set<string>();
  for (const parentId of forkParentIds) {
    const gens = await options.store.listForkGenerations(options.runId, {
      forkParentStageId: parentId,
    });
    for (const gen of gens) {
      if (gen.status !== "superseded") continue;
      for (const id of gen.clone_stage_ids) {
        supersededCloneIds.add(id);
      }
    }
  }
  return supersededCloneIds;
}

export async function createGenerationForFanout(
  store: RunStore,
  runId: string,
  options: {
    replayId?: string;
    forkParentStageId: string;
    cloneStageIds: string[];
  },
): Promise<ForkGenerationRecord> {
  const existing = await store.listForkGenerations(runId, {
    forkParentStageId: options.forkParentStageId,
  });
  const maxNumber = existing.reduce(
    (max, g) => Math.max(max, g.generation_number),
    0,
  );
  return store.createForkGeneration(runId, {
    generation_id: randomUUID(),
    ...(options.replayId !== undefined ? { replay_id: options.replayId } : {}),
    fork_parent_stage_id: options.forkParentStageId,
    generation_number: maxNumber + 1,
    clone_stage_ids: options.cloneStageIds,
    status: "active",
  });
}

export async function mintCohortForFanout(options: {
  store: RunStore;
  runId: string;
  replayId?: string;
  forkParent: string;
  cloneStageIds: string[];
}): Promise<ForkGenerationRecord> {
  return createGenerationForFanout(options.store, options.runId, {
    ...(options.replayId !== undefined ? { replayId: options.replayId } : {}),
    forkParentStageId: options.forkParent,
    cloneStageIds: options.cloneStageIds,
  });
}

export async function activeCloneIdsForParent(
  store: RunStore,
  runId: string,
  forkParentStageId: string,
): Promise<Set<string> | null> {
  return cloneIdsFromActiveCohort(
    await activeCohortForParent(store, runId, forkParentStageId),
  );
}

export async function activeCohortForParent(
  store: RunStore,
  runId: string,
  forkParentStageId: string,
): Promise<ActiveCohort> {
  const gens = await store.listForkGenerations(runId, { forkParentStageId });
  if (gens.length === 0) return { kind: "untracked" };
  const active = gens.filter((g) => g.status === "active");
  if (active.length === 0) return { kind: "awaiting_mint" };
  const ids = new Set<string>();
  for (const gen of active) {
    for (const id of gen.clone_stage_ids) {
      ids.add(id);
    }
  }
  return { kind: "active", cloneIds: ids };
}

export async function selectActiveInput(options: {
  store: RunStore;
  runId: string;
  dag: ResolvedPipelineDag;
  needsStageId: string;
  scheduleOverride?: ReadonlyMap<string, ReadonlySet<string>>;
}): Promise<ActiveCohort> {
  const forkParentId = forkParentForNeedsStage(
    options.dag,
    options.needsStageId,
  );
  if (forkParentId === null) return { kind: "untracked" };

  const override = options.scheduleOverride;
  if (override !== undefined) {
    if (override.size === 0) return { kind: "untracked" };
    const tracked = override.get(forkParentId);
    if (tracked === undefined) return { kind: "untracked" };
    return activeCohortFromCloneIds(tracked);
  }

  return activeCohortForParent(options.store, options.runId, forkParentId);
}

export function filterJoinInputs(
  allInstanceIds: readonly string[],
  cohort: ActiveCohort,
): string[] {
  if (cohort.kind === "untracked") return [...allInstanceIds];
  if (cohort.kind === "awaiting_mint") return [];
  return allInstanceIds.filter((id) => cohort.cloneIds.has(id));
}

export function filterJoinInstanceIds(
  allInstanceIds: readonly string[],
  activeCloneIds: Set<string> | null,
): string[] {
  return filterJoinInputs(
    allInstanceIds,
    activeCohortFromCloneIds(activeCloneIds),
  );
}

/**
 * During an active feedback replay, a fork_choice must keep at least one
 * chosen branch that can still reach the replay source stage.
 */
export function forkChoicePreservesReplaySource(
  dag: ResolvedPipelineDag,
  chosen: ReadonlySet<string>,
  sourceStageId: string,
): boolean {
  const source = dag.nodes.find((n) => n.id === sourceStageId);
  if (source === undefined) return false;
  for (const childId of chosen) {
    if (childId === sourceStageId) return true;
    if (source.ancestors.includes(childId)) return true;
    if (collectDownstreamStageIds(dag, childId).has(sourceStageId)) {
      return true;
    }
    const child = dag.nodes.find((n) => n.id === childId);
    if (parentIsCloneEmitter(dag, child) && !isMintedCloneInstance(child)) {
      const snapshot = asDagSnapshot(dag);
      for (const instanceId of instancesOfDefinition(snapshot, childId)) {
        if (instanceId === childId) continue;
        if (instanceId === sourceStageId) return true;
        if (source.ancestors.includes(instanceId)) return true;
        if (collectDownstreamStageIds(dag, instanceId).has(sourceStageId)) {
          return true;
        }
      }
      if (source.ancestors.includes(childId)) return true;
      const joinDownstream = dag.nodes.filter((n) => n.needs === childId);
      for (const join of joinDownstream) {
        if (join.id === sourceStageId) return true;
        if (collectDownstreamStageIds(dag, join.id).has(sourceStageId)) {
          return true;
        }
        if (source.ancestors.includes(join.id)) return true;
      }
    }
  }
  return false;
}
