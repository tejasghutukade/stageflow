import type { RunStore, RunPipelineDagSnapshot, StageSnapshot } from "../runstore/port.js";
import {
  instancesOfDefinition,
} from "../runstore/pipelineDagSnapshot.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { LoadedPipeline, ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";

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
): Map<string, StageConfig> {
  const map = new Map<string, StageConfig>();
  for (const stage of loaded.stages) {
    map.set(stage.id, stage);
  }
  return map;
}

function dagNode(dag: ResolvedPipelineDag, stageId: string) {
  return dag.nodes.find((node) => node.id === stageId);
}

export type ResolvePriorEnvelopeResult =
  | { ok: true; prior: StageEnvelope | null; joinPriors?: StageEnvelope[] }
  | { ok: false; reason: string };

export async function resolvePriorEnvelope(options: {
  dag: ResolvedPipelineDag;
  stageId: string;
  completedEnvelopes: Map<string, StageEnvelope>;
  store?: RunStore;
  runId?: string;
}): Promise<ResolvePriorEnvelopeResult> {
  const node = dagNode(options.dag, options.stageId);
  if (!node) {
    return {
      ok: false,
      reason: `stage "${options.stageId}" not in pipeline DAG`,
    };
  }
  if (node.needs === null) {
    return { ok: true, prior: null };
  }

  const joinInstances = definitionInstances(options.dag, node.needs);
  if (joinInstances.length > 1) {
    const joinPriors: StageEnvelope[] = [];
    for (const id of joinInstances) {
      const fromMap = options.completedEnvelopes.get(id);
      if (fromMap !== undefined) {
        joinPriors.push(structuredClone(fromMap));
        continue;
      }
      if (options.store !== undefined && options.runId !== undefined) {
        try {
          const envelope = await options.store.readEnvelope(options.runId, id);
          joinPriors.push(structuredClone(envelope));
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

  const parentId = node.needs;
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

  for (const item of parent.clone_forks ?? []) {
    if (item.action === "once" && item.successor_id === options.stageId) {
      return { ok: true, prior: structuredClone(item.envelope) };
    }
    if (item.action === "fanout") {
      const instanceIds = definitionInstances(options.dag, item.successor_id);
      const index = instanceIds.indexOf(options.stageId);
      if (index >= 0) {
        const clone = item.clones[index];
        if (clone === undefined) {
          return {
            ok: false,
            reason: `missing clone envelope for instance "${options.stageId}"`,
          };
        }
        return { ok: true, prior: structuredClone(clone.envelope) };
      }
    }
  }

  return { ok: true, prior: structuredClone(parent) };
}
