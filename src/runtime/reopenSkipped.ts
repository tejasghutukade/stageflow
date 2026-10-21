import { normalizeForkChoice } from "../envelope/forkChoice.js";
import type { RunStore } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import { forkCohortMapsFromStore } from "./forkGeneration.js";
import { joinAllowsRun } from "./joinReadiness.js";
import type { StageScheduleState } from "./pipelineScheduler.js";

export function isUnchosenForkChild(
  dag: ResolvedPipelineDag,
  stageId: string,
  envelopes: Map<string, StageEnvelope>,
): boolean {
  for (const node of dag.nodes) {
    const envelope = envelopes.get(node.id);
    if (envelope?.fork_choice === undefined || envelope.fork_choice === null) {
      continue;
    }
    const children = dag.childrenOf[node.id] ?? [];
    if (!children.includes(stageId)) continue;
    const chosen = normalizeForkChoice(envelope.fork_choice, "stored");
    if (!chosen.has(stageId)) return true;
  }
  return false;
}

export function eventsShowStarted(
  events: ReadonlyArray<{ event: string }>,
): boolean {
  return events.some(
    (event) => event.event === "started" || event.event === "resumed",
  );
}

export function shouldReopenSkippedStage(
  dag: ResolvedPipelineDag,
  stageId: string,
  states: Map<string, StageScheduleState>,
  envelopes: Map<string, StageEnvelope>,
  hasStarted: boolean,
  options?: {
    supersededCloneIds?: ReadonlySet<string>;
  },
): boolean {
  if (hasStarted) return false;
  if (options?.supersededCloneIds?.has(stageId)) return false;
  if (states.get(stageId) !== "skipped") return false;
  if (isUnchosenForkChild(dag, stageId, envelopes)) return false;
  const hypothetical = new Map(states);
  hypothetical.set(stageId, "pending");
  return joinAllowsRun(dag, stageId, hypothetical, envelopes);
}

export async function persistReopenedStages(
  store: Pick<RunStore, "appendStageEvent">,
  runId: string,
  stageIds: Iterable<string>,
  states: Map<string, StageScheduleState>,
): Promise<void> {
  for (const id of stageIds) {
    if (states.get(id) !== "skipped") continue;
    await store.appendStageEvent(runId, id, { event: "reopened" });
    states.set(id, "pending");
  }
}

export async function reopenRunnableSkippedStages(
  store: Pick<RunStore, "appendStageEvent" | "listStageEvents" | "listForkGenerations">,
  runId: string,
  dag: ResolvedPipelineDag,
  states: Map<string, StageScheduleState>,
  envelopes: Map<string, StageEnvelope>,
): Promise<void> {
  const { supersededCloneIds } = await forkCohortMapsFromStore(store, runId);
  const ids: string[] = [];
  for (const [id, state] of states) {
    if (state !== "skipped") continue;
    const events = await store.listStageEvents(runId, id);
    if (
      !shouldReopenSkippedStage(
        dag,
        id,
        states,
        envelopes,
        eventsShowStarted(events),
        { supersededCloneIds },
      )
    ) {
      continue;
    }
    ids.push(id);
  }
  await persistReopenedStages(store, runId, ids, states);
}
