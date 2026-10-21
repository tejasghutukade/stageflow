import type { PipelineListing, RunSummary, StageGateKind } from "./api";

export type StageLibraryRow = {
  id: string;
  gate_kinds?: StageGateKind[];
  pipelineIds: string[];
};

export function stageMayAsk(
  gateKinds: unknown[] | undefined,
): boolean {
  return Array.isArray(gateKinds) && gateKinds.length > 0;
}

export function gateCount(
  stages: { gate_kinds?: unknown[] }[],
): number {
  return stages.filter((stage) => stageMayAsk(stage.gate_kinds)).length;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runShortId(runId: string): string {
  if (UUID_RE.test(runId)) return runId.slice(0, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(runId)) {
    const suffix = runId.replace(/^\d{4}-\d{2}-\d{2}[T\-_:.Z]*/i, "").replace(/[^\w]/g, "");
    if (suffix.length >= 4) return suffix.slice(0, 8);
    const parsed = Date.parse(runId);
    if (Number.isFinite(parsed)) {
      const d = new Date(parsed);
      const hex = parsed.toString(36).replace(/[^\w]/g, "");
      if (hex.length >= 4) return hex.slice(-8);
      return `${d.getUTCMonth() + 1}${d.getUTCDate()}${d.getUTCHours()}${d.getUTCMinutes()}`.slice(0, 8);
    }
  }
  if (runId.length <= 8) return runId;
  return runId.slice(-8);
}

export function formatRunShortTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return runShortId(iso);
  const d = new Date(t);
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
  return `${month} ${day} · ${time}`;
}

export function runAnsweredGateLabel(run: RunSummary): string {
  if (run.waiting_stage_id) return run.waiting_stage_id;
  const stages = run.stages ?? [];
  const lastSucceeded = [...stages].reverse().find((s) => s.status === "succeeded");
  if (lastSucceeded) return lastSucceeded.id;
  if (run.failed_stage_id) return run.failed_stage_id;
  return runShortId(run.run_id);
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return runShortId(iso);
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
        if (existing.gate_kinds === undefined && stage.gate_kinds !== undefined) {
          existing.gate_kinds = [...stage.gate_kinds];
        } else if (
          existing.gate_kinds !== undefined &&
          existing.gate_kinds.length === 0 &&
          stage.gate_kinds?.length
        ) {
          existing.gate_kinds = [...stage.gate_kinds];
        }
      } else {
        map.set(stage.id, {
          id: stage.id,
          ...(stage.gate_kinds !== undefined
            ? { gate_kinds: [...stage.gate_kinds] }
            : {}),
          pipelineIds: [pipeline.id],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
