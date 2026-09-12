import { isNeedTerminalState, predecessorEdges } from "../config/pipelineNeeds.js";
import type { RunPipelineDagSnapshot } from "../runstore/port.js";
import { instancesOfDefinition } from "../runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  PipelineNeedEdge,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import type { StageScheduleState } from "./pipelineScheduler.js";
import { evaluateRouteIf, type RouteIfEval } from "./routeIfEval.js";

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

function collectJoinParentInstances(
  dag: ResolvedPipelineDag,
  edges: PipelineNeedEdge[],
): string[] | undefined {
  const ids: string[] = [];
  for (const edge of edges) {
    const instances = definitionInstances(dag, edge.id);
    if (instances.length === 0) return undefined;
    ids.push(...instances);
  }
  return ids;
}

function joinParentDisposition(
  dag: ResolvedPipelineDag,
  edges: PipelineNeedEdge[],
  states: Map<string, StageScheduleState>,
):
  | { allTerminal: false }
  | {
      allTerminal: true;
      hasFailed: boolean;
      hasSucceeded: boolean;
      hasSkipped: boolean;
    }
  | undefined {
  const instances = collectJoinParentInstances(dag, edges);
  if (instances === undefined) return undefined;
  let hasFailed = false;
  let hasSucceeded = false;
  let hasSkipped = false;
  for (const id of instances) {
    const state = states.get(id);
    if (!isNeedTerminalState(state)) {
      return { allTerminal: false };
    }
    if (state === "failed") hasFailed = true;
    if (state === "succeeded") hasSucceeded = true;
    if (state === "skipped") hasSkipped = true;
  }
  return { allTerminal: true, hasFailed, hasSucceeded, hasSkipped };
}

export function inboundEdgeFired(
  edge: PipelineNeedEdge,
  parentId: string,
  states: Map<string, StageScheduleState>,
  envelopes: Map<string, StageEnvelope>,
): boolean {
  if (edge.if === undefined) return true;
  if (states.get(parentId) !== "succeeded") return false;
  return evaluateRouteIf(edge.if, envelopes.get(parentId)?.payload) === "fire";
}

function inboundEdgeMissed(
  edge: PipelineNeedEdge,
  parentId: string,
  envelopes: Map<string, StageEnvelope>,
): boolean {
  if (edge.if === undefined) return false;
  return evaluateRouteIf(edge.if, envelopes.get(parentId)?.payload) === "miss";
}

function everySucceededInboundEdgeFired(
  dag: ResolvedPipelineDag,
  edges: PipelineNeedEdge[],
  states: Map<string, StageScheduleState>,
  envelopes: Map<string, StageEnvelope>,
): boolean {
  for (const edge of edges) {
    const instances = collectJoinParentInstances(dag, [edge]);
    const ids = instances ?? [edge.id];
    for (const id of ids) {
      if (!inboundEdgeFired(edge, id, states, envelopes)) return false;
    }
  }
  return true;
}

function anySucceededInboundEdgeMissed(
  dag: ResolvedPipelineDag,
  edges: PipelineNeedEdge[],
  envelopes: Map<string, StageEnvelope>,
): boolean {
  for (const edge of edges) {
    const instances = collectJoinParentInstances(dag, [edge]);
    const ids = instances ?? [edge.id];
    for (const id of ids) {
      if (inboundEdgeMissed(edge, id, envelopes)) return true;
    }
  }
  return false;
}

function multiParentJoinAllowsRun(
  dag: ResolvedPipelineDag,
  node: ResolvedPipelineStageNode,
  states: Map<string, StageScheduleState>,
  envelopes: Map<string, StageEnvelope>,
): boolean {
  const edges = predecessorEdges(node);
  if (edges.length < 2) return false;
  const disposition = joinParentDisposition(dag, edges, states);
  if (disposition === undefined || !disposition.allTerminal) return false;
  if (disposition.hasFailed) return false;
  if (!disposition.hasSucceeded) return false;
  if (!disposition.hasSkipped) {
    return everySucceededInboundEdgeFired(dag, edges, states, envelopes);
  }
  return true;
}

/**
 * A multi-parent join whose parents are all terminal, none failed, and
 * either every parent skipped, or every parent succeeded but an inbound
 * `if` missed. Those joins cannot run, so the scheduler force-skips them.
 * A failed parent is not stalled: the join stays pending. A still-running
 * parent is not stalled either.
 */
function isStalledMultiParentJoin(
  dag: ResolvedPipelineDag,
  node: ResolvedPipelineStageNode,
  states: Map<string, StageScheduleState>,
  envelopes: Map<string, StageEnvelope>,
): boolean {
  const edges = predecessorEdges(node);
  if (edges.length <= 1) return false;
  const disposition = joinParentDisposition(dag, edges, states);
  if (disposition === undefined || !disposition.allTerminal) return false;
  if (disposition.hasFailed) return false;
  if (!disposition.hasSucceeded) return true;
  if (disposition.hasSkipped) return false;
  return anySucceededInboundEdgeMissed(dag, edges, envelopes);
}

export function joinAllowsRun(
  dag: ResolvedPipelineDag,
  stageId: string,
  states: Map<string, StageScheduleState>,
  envelopes: Map<string, StageEnvelope>,
): boolean {
  const node = dag.nodes.find((n) => n.id === stageId);
  if (!node) return false;
  const edges = predecessorEdges(node);
  if (edges.length >= 2) {
    return multiParentJoinAllowsRun(dag, node, states, envelopes);
  }
  if (edges.length !== 1) return false;
  const edge = edges[0]!;
  const parentNeedId =
    typeof node.needs === "string" && node.needs ? node.needs : edge.id;
  const parentId = definitionInstances(dag, parentNeedId)[0] ?? parentNeedId;
  if (states.get(parentId) !== "succeeded") return false;
  if (edge.if === undefined) return true;
  return inboundEdgeFired(edge, parentId, states, envelopes);
}

export type InboundAfterSuccess = RouteIfEval | "ungated";

export function classifyInboundAfterSuccess(
  node: Pick<ResolvedPipelineStageNode, "needs" | "needsEdges">,
  parentId: string,
  payload: Record<string, unknown> | undefined,
): InboundAfterSuccess {
  const inbound = predecessorEdges(node).find((edge) => edge.id === parentId);
  if (inbound?.if === undefined) return "ungated";
  return evaluateRouteIf(inbound.if, payload);
}

export function isEagerSingleParentIfSkip(
  node: Pick<ResolvedPipelineStageNode, "needs" | "needsEdges">,
  parentId: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (predecessorEdges(node).length !== 1) return false;
  return classifyInboundAfterSuccess(node, parentId, payload) === "miss";
}

/**
 * Finds pending multi-parent joins that cannot run once every parent is
 * terminal: all-skipped, or all-succeeded with an inbound `if` miss.
 * A failed parent is not a stalled skip — that join stays pending.
 */
export function pickStalledJoinSkips(
  dag: ResolvedPipelineDag,
  states: Map<string, StageScheduleState>,
  completedEnvelopes: Map<string, StageEnvelope> = new Map(),
): string[] {
  const ids: string[] = [];
  for (const node of dag.nodes) {
    if (states.get(node.id) !== "pending") continue;
    if (isStalledMultiParentJoin(dag, node, states, completedEnvelopes)) {
      ids.push(node.id);
    }
  }
  return ids;
}
