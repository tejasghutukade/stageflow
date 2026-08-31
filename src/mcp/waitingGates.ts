import type {
  RunStore,
  RunSummary,
  StageSnapshot,
} from "../runstore/port.js";

export function projectWaitingGate(opts: {
  runId: string;
  stageId: string;
  stage: StageSnapshot;
  summary: RunSummary;
}): Record<string, unknown> {
  const { runId, stageId, stage, summary } = opts;
  const prompt = stage.pending_prompt;
  const item: Record<string, unknown> = {
    runId,
    stageId,
  };
  if (prompt !== undefined) {
    item.waiting_kind = prompt.kind;
    item.waiting_prompt_id = prompt.id;
    item.pending_prompt = prompt;
    if (prompt.kind === "multi_question") {
      item.waiting_questions = prompt.questions.map((q) => q.message);
    } else {
      item.waiting_summary = prompt.message;
    }
    if (prompt.kind === "artifact_backed") {
      item.waiting_artifacts = prompt.artifacts;
    }
  } else if (stageId === summary.waiting_stage_id) {
    if (summary.waiting_kind !== undefined) {
      item.waiting_kind = summary.waiting_kind;
    }
    if (summary.waiting_summary !== undefined) {
      item.waiting_summary = summary.waiting_summary;
    }
    if (summary.waiting_prompt_id !== undefined) {
      item.waiting_prompt_id = summary.waiting_prompt_id;
    }
    if (summary.waiting_artifacts !== undefined) {
      item.waiting_artifacts = summary.waiting_artifacts;
    }
    if (summary.waiting_questions !== undefined) {
      item.waiting_questions = summary.waiting_questions;
    }
  }
  return item;
}

export async function projectWaitingGates(
  store: RunStore,
  opts?: { runId?: string },
): Promise<Array<Record<string, unknown>>> {
  const summaries = opts?.runId
    ? (await store.listRuns()).filter((r) => r.run_id === opts.runId)
    : await store.listRuns();
  const waiting = summaries.filter(
    (r) =>
      (r.waiting_stage_ids !== undefined && r.waiting_stage_ids.length > 0) ||
      r.waiting_stage_id !== undefined,
  );

  const items: Array<Record<string, unknown>> = [];
  for (const summary of waiting) {
    const stageIds =
      summary.waiting_stage_ids ??
      (summary.waiting_stage_id !== undefined
        ? [summary.waiting_stage_id]
        : []);
    let detail;
    try {
      detail = await store.readRun(summary.run_id);
    } catch {
      continue;
    }
    for (const stageId of stageIds) {
      const stage = detail.stages.find((s) => s.stage_id === stageId);
      if (!stage || stage.status !== "waiting_for_input") continue;
      items.push(
        projectWaitingGate({
          runId: summary.run_id,
          stageId,
          stage,
          summary,
        }),
      );
    }
  }
  return items;
}
