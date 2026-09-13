import { predecessorEdges } from "../config/pipelineNeeds.js";
import type { RunStore, RunPipelineDagSnapshot, StageSnapshot } from "../runstore/port.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type {
  StageEnvelope,
  TerminalEnvelope,
} from "../types/envelope.js";
import type {
  LoadedPipeline,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import type { LoadedStageConfig } from "../types/stage.js";
import {
  activeCohortFromCloneIds,
  filterJoinInputs,
  selectActiveInput,
  type ActiveCohort,
} from "./forkGeneration.js";
import { expandJoinParent } from "./joinReadiness.js";

async function resolveActiveCohortForNeeds(
  dag: ResolvedPipelineDag,
  needsId: string,
  store?: RunStore,
  runId?: string,
  activeCloneIds?: Set<string> | null,
  scheduleOverride?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ActiveCohort> {
  if (activeCloneIds !== undefined) {
    return activeCohortFromCloneIds(activeCloneIds);
  }
  if (store === undefined || runId === undefined) return { kind: "untracked" };
  return selectActiveInput({
    store,
    runId,
    dag,
    needsStageId: needsId,
    ...(scheduleOverride !== undefined ? { scheduleOverride } : {}),
  });
}

export async function buildCompletedEnvelopesFromRun(
  store: RunStore,
  runId: string,
  stages?: StageSnapshot[],
  dag?: ResolvedPipelineDag,
): Promise<Map<string, StageEnvelope>> {
  const completedEnvelopes = new Map<string, StageEnvelope>();
  const snapshotStages = stages ?? (await store.readRun(runId)).stages;
  for (const snap of snapshotStages) {
    const isCloneInstance =
      dag !== undefined &&
      definitionIdForInstance(dag as RunPipelineDagSnapshot, snap.stage_id) !==
        snap.stage_id;
    if (snap.status !== "succeeded" && !(snap.status === "failed" && isCloneInstance)) {
      continue;
    }
    try {
      const envelope =
        snap.envelope ?? (await store.readEnvelope(runId, snap.stage_id));
      completedEnvelopes.set(snap.stage_id, envelope);
    } catch {
      if (snap.status === "failed" && isCloneInstance) {
        completedEnvelopes.set(snap.stage_id, {
          status: "failure",
          summary: "stage failed",
          artifacts: [],
        });
      }
    }
  }
  return completedEnvelopes;
}

export function buildStageConfigById(
  loaded: LoadedPipeline,
): Map<string, LoadedStageConfig> {
  const map = new Map<string, LoadedStageConfig>();
  for (const stage of loaded.stages) {
    map.set(stage.id, stage);
  }
  return map;
}

function dagNode(dag: ResolvedPipelineDag, stageId: string) {
  return dag.nodes.find((node) => node.id === stageId);
}

export type ResolvePriorEnvelopeResult =
  | {
      ok: true;
      prior: StageEnvelope | null;
      joinPriors?: StageEnvelope[];
      priorEnvelopesByStage?: Record<string, TerminalEnvelope | TerminalEnvelope[]>;
    }
  | { ok: false; reason: string };

type ResolvePriorEnvelopeOptions = {
  dag: ResolvedPipelineDag;
  stageId: string;
  completedEnvelopes: Map<string, StageEnvelope>;
  store?: RunStore;
  runId?: string;
  stages?: StageSnapshot[];
  /** When set (including null), skips store lookup for active fork generation. */
  activeCloneIds?: Set<string> | null;
  scheduleOverride?: ReadonlyMap<string, ReadonlySet<string>>;
};

async function loadStageSnapshots(
  options: ResolvePriorEnvelopeOptions,
): Promise<StageSnapshot[]> {
  if (options.stages !== undefined) return options.stages;
  if (options.store !== undefined && options.runId !== undefined) {
    return (await options.store.readRun(options.runId)).stages;
  }
  return [];
}

async function readCachedEnvelope(
  options: ResolvePriorEnvelopeOptions,
  snapshots: Map<string, StageSnapshot>,
  stageId: string,
): Promise<StageEnvelope | undefined> {
  const fromMap = options.completedEnvelopes.get(stageId);
  if (fromMap !== undefined) return structuredClone(fromMap);
  const snap = snapshots.get(stageId);
  if (snap?.envelope) return structuredClone(snap.envelope);
  if (options.store !== undefined && options.runId !== undefined) {
    try {
      return structuredClone(await options.store.readEnvelope(options.runId, stageId));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function successTerminalForPersistedStage(
  options: ResolvePriorEnvelopeOptions,
  snapshots: Map<string, StageSnapshot>,
  stageId: string,
): Promise<
  | { ok: true; value: TerminalEnvelope }
  | { ok: true; omit: true }
  | { ok: false; reason: string }
> {
  const snap = snapshots.get(stageId);
  if (snap?.status === "skipped" || snap?.status === "failed") {
    return { ok: true, omit: true };
  }
  if (snap?.status === "succeeded") {
    const envelope = await readCachedEnvelope(options, snapshots, stageId);
    if (envelope === undefined) {
      return {
        ok: false,
        reason: `missing envelope for upstream stage "${stageId}"`,
      };
    }
    if (envelope.status !== "success") {
      return { ok: true, omit: true };
    }
    return { ok: true, value: envelope };
  }
  const fromMap = options.completedEnvelopes.get(stageId);
  if (fromMap?.status === "success") {
    return { ok: true, value: structuredClone(fromMap) };
  }
  if (fromMap !== undefined) {
    return { ok: true, omit: true };
  }
  return {
    ok: false,
    reason: `missing envelope for upstream stage "${stageId}"`,
  };
}

async function resolveGenericJoinPriors(
  options: ResolvePriorEnvelopeOptions,
  node: ResolvedPipelineStageNode,
): Promise<ResolvePriorEnvelopeResult> {
  const snapshots = new Map(
    (await loadStageSnapshots(options)).map((snap) => [snap.stage_id, snap]),
  );
  const priorEnvelopesByStage: Record<string, TerminalEnvelope | TerminalEnvelope[]> = {};

  for (const edge of predecessorEdges(node)) {
    const parentId = edge.id;
    const expanded = expandJoinParent(options.dag, parentId);
    if (expanded.length > 1 || expanded[0] !== parentId) {
      const list: TerminalEnvelope[] = [];
      for (const id of expanded) {
        const terminal = await successTerminalForPersistedStage(
          options,
          snapshots,
          id,
        );
        if (!terminal.ok) return terminal;
        if ("omit" in terminal) continue;
        list.push(terminal.value);
      }
      if (list.length > 0) {
        priorEnvelopesByStage[parentId] = list;
      }
      continue;
    }

    const terminal = await successTerminalForPersistedStage(
      options,
      snapshots,
      parentId,
    );
    if (!terminal.ok) return terminal;
    if ("omit" in terminal) continue;
    priorEnvelopesByStage[parentId] = terminal.value;
  }

  return { ok: true, prior: null, priorEnvelopesByStage };
}

export async function resolvePriorEnvelope(
  options: ResolvePriorEnvelopeOptions,
): Promise<ResolvePriorEnvelopeResult> {
  const node = dagNode(options.dag, options.stageId);
  if (!node) {
    return {
      ok: false,
      reason: `stage "${options.stageId}" not in pipeline DAG`,
    };
  }

  const edges = predecessorEdges(node);
  if (edges.length === 0) {
    return { ok: true, prior: null };
  }
  if (edges.length >= 2) {
    return resolveGenericJoinPriors(options, node);
  }

  const parentId =
    typeof node.needs === "string" && node.needs ? node.needs : edges[0]!.id;
  const expanded = expandJoinParent(options.dag, parentId);
  if (expanded.length > 1 || expanded[0] !== parentId) {
    const cohort = await resolveActiveCohortForNeeds(
      options.dag,
      parentId,
      options.store,
      options.runId,
      options.activeCloneIds,
      options.scheduleOverride,
    );
    const joinInstances = filterJoinInputs(expanded, cohort);
    const snapshots = new Map(
      (await loadStageSnapshots(options)).map((snap) => [snap.stage_id, snap]),
    );
    const joinPriors: StageEnvelope[] = [];
    for (const id of joinInstances) {
      const snap = snapshots.get(id);
      if (snap?.status === "skipped" || snap?.status === "failed") {
        continue;
      }
      const fromMap = options.completedEnvelopes.get(id);
      if (fromMap !== undefined) {
        if (fromMap.status === "success") {
          joinPriors.push(structuredClone(fromMap));
        }
        continue;
      }
      if (options.store !== undefined && options.runId !== undefined) {
        try {
          const envelope = await options.store.readEnvelope(options.runId, id);
          if (envelope.status === "success") {
            joinPriors.push(structuredClone(envelope));
          }
          continue;
        } catch {
          return {
            ok: false,
            reason: `missing envelope for clone instance "${id}"`,
          };
        }
      }
      return {
        ok: false,
        reason: `missing envelope for clone instance "${id}"`,
      };
    }
    return { ok: true, prior: null, joinPriors };
  }

  const fromMap = options.completedEnvelopes.get(parentId);
  let parent: StageEnvelope | undefined = fromMap;
  if (parent === undefined && options.store !== undefined && options.runId !== undefined) {
    try {
      parent = await options.store.readEnvelope(options.runId, parentId);
    } catch {
      return {
        ok: false,
        reason: `missing envelope for upstream stage "${parentId}"`,
      };
    }
  }
  if (parent === undefined) {
    return {
      ok: false,
      reason: `missing envelope for upstream stage "${parentId}"`,
    };
  }

  return { ok: true, prior: structuredClone(parent) };
}
