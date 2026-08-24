import type { PipelineListing, RunSummary, StageGateKind } from "./api";

export type StageLibraryRow = {
  id: string;
  gate_kinds: StageGateKind[];
  pipelineIds: string[];
};

export function gateCount(
  stages: { gate_kinds?: unknown[] }[],
): number {
  return stages.filter((stage) => (stage.gate_kinds?.length ?? 0) > 0).length;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const ms = Math.max(0, now - then);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function stageIndexLabel(
  stages: { id: string }[] | undefined,
  stageId: string | undefined,
): string | undefined {
  if (!stages?.length || !stageId) return undefined;
  const index = stages.findIndex((s) => s.id === stageId);
  if (index < 0) return undefined;
  return `stage ${index + 1} of ${stages.length}`;
}

export function miniTrackLabel(run: RunSummary): string | undefined {
  if (run.waiting_stage_id) {
    const kind = run.waiting_kind ? ` · ${run.waiting_kind}` : "";
    return `${run.waiting_stage_id} · asked you${kind}`;
  }
  const running = run.stages?.find((s) => s.status === "running");
  if (running) return running.id;
  if (run.failed_stage_id) return run.failed_stage_id;
  return undefined;
}

export function stageLibrary(pipelines: PipelineListing[]): StageLibraryRow[] {
  const map = new Map<string, StageLibraryRow>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      const existing = map.get(stage.id);
      if (existing) {
        existing.pipelineIds.push(pipeline.id);
        if (existing.gate_kinds.length === 0 && stage.gate_kinds?.length) {
          existing.gate_kinds = [...stage.gate_kinds];
        }
      } else {
        map.set(stage.id, {
          id: stage.id,
          gate_kinds: stage.gate_kinds ? [...stage.gate_kinds] : [],
          pipelineIds: [pipeline.id],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
