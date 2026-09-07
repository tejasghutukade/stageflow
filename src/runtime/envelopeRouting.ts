import { predecessorEdges } from "../config/pipelineNeeds.js";
import type { RunStore, RunPipelineDagSnapshot, StageSnapshot } from "../runstore/port.js";
import {
  instancesOfDefinition,
} from "../runstore/pipelineDagSnapshot.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type {
  StageEnvelope,
  SyntheticSkippedEnvelope,
  TerminalEnvelope,
} from "../types/envelope.js";
import type {
  LoadedPipeline,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
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

const SYNTHETIC_SKIPPED_TERMINAL: SyntheticSkippedEnvelope = {
  status: "skipped",
  summary: "stage was skipped",
  artifacts: [],
};

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
};

function mintedCloneInstances(dag: ResolvedPipelineDag, parentId: string): string[] {
  return definitionInstances(dag, parentId).filter((id) => id !== parentId);
}

function isClonableParent(dag: ResolvedPipelineDag, parentId: string): boolean {
  const node = dagNode(dag, parentId);
  return node?.clonable === true || mintedCloneInstances(dag, parentId).length > 0;
}

function failureReasonFromSnapshot(snap: StageSnapshot | undefined): string {
  let reason = "stage failed";
  if (snap === undefined) return reason;
  for (const ev of snap.events) {
    if (ev.event === "failed" && typeof ev.reason === "string" && ev.reason) {
      reason = ev.reason;
    }
  }
  return reason;
}

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

async function terminalForPersistedStage(
  options: ResolvePriorEnvelopeOptions,
  snapshots: Map<string, StageSnapshot>,
  stageId: string,
): Promise<{ ok: true; value: TerminalEnvelope } | { ok: false; reason: string }> {
  const snap = snapshots.get(stageId);
  if (snap?.status === "skipped") {
    return { ok: true, value: { ...SYNTHETIC_SKIPPED_TERMINAL } };
  }
  if (snap?.status === "failed") {
    const envelope = await readCachedEnvelope(options, snapshots, stageId);
    if (envelope?.status === "failure") {
      return { ok: true, value: envelope };
    }
    return {
      ok: true,
      value: {
        status: "failure",
        summary: failureReasonFromSnapshot(snap),
        artifacts: [],
      },
    };
  }
  if (snap?.status === "succeeded") {
    const envelope = await readCachedEnvelope(options, snapshots, stageId);
    if (envelope === undefined) {
      return {
        ok: false,
        reason: `missing envelope for upstream stage "${stageId}"`,
      };
    }
    return { ok: true, value: envelope };
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
    if (isClonableParent(options.dag, parentId)) {
      const minted = mintedCloneInstances(options.dag, parentId);
      if (minted.length > 0) {
        const list: TerminalEnvelope[] = [];
        for (const id of minted) {
          const terminal = await terminalForPersistedStage(options, snapshots, id);
          if (!terminal.ok) return terminal;
          list.push(terminal.value);
        }
        priorEnvelopesByStage[parentId] = list;
        continue;
      }
      if (snapshots.get(parentId)?.status === "skipped") {
        priorEnvelopesByStage[parentId] = [];
        continue;
      }
      const once = await terminalForPersistedStage(options, snapshots, parentId);
      if (!once.ok) return once;
      priorEnvelopesByStage[parentId] = [once.value];
      continue;
    }

    const terminal = await terminalForPersistedStage(options, snapshots, parentId);
    if (!terminal.ok) return terminal;
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
  const joinInstances = definitionInstances(options.dag, parentId);
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
