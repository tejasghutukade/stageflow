import type { RunStore, StageSnapshot } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { LoadedPipeline, ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";

export async function buildCompletedEnvelopesFromRun(
  store: RunStore,
  runId: string,
  stages?: StageSnapshot[],
): Promise<Map<string, StageEnvelope>> {
  const completedEnvelopes = new Map<string, StageEnvelope>();
  const snapshotStages = stages ?? (await store.readRun(runId)).stages;
  for (const snap of snapshotStages) {
    if (snap.status !== "succeeded") continue;
    try {
      const envelope =
        snap.envelope ?? (await store.readEnvelope(runId, snap.stage_id));
      completedEnvelopes.set(snap.stage_id, envelope);
    } catch {
      // envelope may be missing for corrupt runs; leave map empty
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
  | { ok: true; prior: StageEnvelope | null }
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

  const parentId = node.needs;
  const fromMap = options.completedEnvelopes.get(parentId);
  if (fromMap !== undefined) {
    return { ok: true, prior: structuredClone(fromMap) };
  }

  if (options.store !== undefined && options.runId !== undefined) {
    try {
      const envelope = await options.store.readEnvelope(
        options.runId,
        parentId,
      );
      return { ok: true, prior: structuredClone(envelope) };
    } catch {
      return {
        ok: false,
        reason: `missing envelope for upstream stage "${parentId}"`,
      };
    }
  }

  return {
    ok: false,
    reason: `missing envelope for upstream stage "${parentId}"`,
  };
}
