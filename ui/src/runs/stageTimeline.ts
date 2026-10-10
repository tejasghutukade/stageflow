import type { RunDetail, StageLogEvent, StageSnapshot, StageReadiness } from "../api";

export type TimelineSegmentKind =
  | "empty"
  | "queued"
  | "blocked"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

export type StageTrackReadiness = Pick<
  { readiness: StageReadiness },
  "readiness"
>;

export type TimelineSegment = {
  kind: TimelineSegmentKind;
  startMs: number;
  endMs: number;
};

export type TimelineBounds = {
  startMs: number;
  endMs: number;
};

function eventAt(events: StageLogEvent[], name: string): number | undefined {
  for (const ev of events) {
    if (ev.event !== name || !ev.at) continue;
    const ms = Date.parse(ev.at);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function lastEventAt(events: StageLogEvent[], names: string[]): number | undefined {
  let best: number | undefined;
  for (const ev of events) {
    if (!names.includes(ev.event) || !ev.at) continue;
    const ms = Date.parse(ev.at);
    if (!Number.isFinite(ms)) continue;
    if (best === undefined || ms > best) best = ms;
  }
  return best;
}

export function timelineBounds(
  run: Pick<RunDetail, "created_at" | "finished_at">,
  stages: StageSnapshot[],
  now = Date.now(),
): TimelineBounds {
  const startMs = Date.parse(run.created_at);
  let endMs = run.finished_at ? Date.parse(run.finished_at) : now;
  if (!Number.isFinite(endMs)) endMs = now;
  for (const stage of stages) {
    for (const seg of stageSegments(stage, now)) {
      if (seg.endMs > endMs) endMs = seg.endMs;
    }
  }
  if (!Number.isFinite(startMs)) {
    return { startMs: now, endMs: Math.max(now, endMs) };
  }
  return { startMs, endMs: Math.max(endMs, startMs) };
}

export function stageSegments(
  stage: StageSnapshot,
  now = Date.now(),
  trackNode?: StageTrackReadiness,
): TimelineSegment[] {
  const events = stage.events ?? [];
  const started = eventAt(events, "started");
  const waitingAt = eventAt(events, "waiting_for_input");
  const answeredAt = lastEventAt(events, [
    "operator_answer",
    "operator_prompt_answered",
  ]);
  const succeededAt = eventAt(events, "succeeded");
  const failedAt = eventAt(events, "failed");
  const skippedAt = eventAt(events, "skipped");

  if (stage.status === "pending" && !started) {
    if (trackNode?.readiness === "blocked") {
      return [{ kind: "blocked", startMs: now, endMs: now }];
    }
    return [{ kind: "empty", startMs: now, endMs: now }];
  }

  const segments: TimelineSegment[] = [];
  const runStart = started ?? waitingAt ?? now;

  if (started === undefined && stage.status !== "pending") {
    const terminal =
      succeededAt ?? failedAt ?? skippedAt ?? waitingAt ?? now;
    return [{ kind: "running", startMs: runStart, endMs: terminal }];
  }

  if (started !== undefined) {
    const runEnd =
      waitingAt ??
      succeededAt ??
      failedAt ??
      skippedAt ??
      (stage.status === "running" ? now : started);
    if (runEnd > started) {
      segments.push({ kind: "running", startMs: started, endMs: runEnd });
    }
  }

  if (
    stage.status === "waiting_for_input" ||
    (waitingAt !== undefined && !answeredAt && !succeededAt && !failedAt)
  ) {
    const wStart = waitingAt ?? started ?? now;
    const wEnd =
      stage.status === "waiting_for_input"
        ? now
        : (answeredAt ?? succeededAt ?? failedAt ?? now);
    if (wEnd >= wStart) {
      segments.push({ kind: "waiting", startMs: wStart, endMs: wEnd });
    }
  } else if (waitingAt !== undefined && answeredAt !== undefined) {
    segments.push({
      kind: "waiting",
      startMs: waitingAt,
      endMs: answeredAt,
    });
  }

  if (stage.status === "succeeded" || succeededAt !== undefined) {
    const tStart = succeededAt ?? lastEventAt(events, ["started"]) ?? now;
    const tEnd = succeededAt ?? tStart;
    segments.push({ kind: "succeeded", startMs: tStart, endMs: tEnd });
  } else if (stage.status === "failed" || failedAt !== undefined) {
    const tStart = failedAt ?? lastEventAt(events, ["started"]) ?? now;
    const tEnd = failedAt ?? tStart;
    segments.push({ kind: "failed", startMs: tStart, endMs: tEnd });
  } else if (stage.status === "skipped" || skippedAt !== undefined) {
    const tStart = skippedAt ?? now;
    segments.push({ kind: "skipped", startMs: tStart, endMs: tStart });
  }

  if (segments.length === 0) {
    return [{ kind: "queued", startMs: runStart, endMs: runStart }];
  }

  return segments;
}

export function stageRowDurationMs(
  stage: StageSnapshot,
  now = Date.now(),
): number {
  return stageSegments(stage, now).reduce(
    (sum, seg) => sum + Math.max(0, seg.endMs - seg.startMs),
    0,
  );
}

const AXIS_UNITS = [1_000, 60_000, 3_600_000, 86_400_000];
const AXIS_STEPS = [1, 2, 4, 5, 10, 15, 20, 30, 45, 60];
const MAX_NOW_FRACTION = 0.92;

export function axisSpanMs(elapsedMs: number, open: boolean): number {
  const elapsed = Math.max(0, elapsedMs);
  if (!open) return Math.max(elapsed, 1);
  const needed = Math.max(elapsed + 1, elapsed / MAX_NOW_FRACTION);
  for (const unit of AXIS_UNITS) {
    for (const step of AXIS_STEPS) {
      const horizon = step * unit;
      if (horizon >= needed) return horizon;
    }
  }
  return needed;
}

export function isFutureTimelineStage(stage: StageSnapshot): boolean {
  if (stage.status !== "pending") return false;
  return !stage.events?.some((event) => event.event === "started");
}

function settledKind(stage: StageSnapshot): TimelineSegmentKind | null {
  if (stage.status === "succeeded") return "succeeded";
  if (stage.status === "failed") return "failed";
  if (stage.status === "skipped") return "skipped";
  return null;
}

export function visibleStageBars(
  stage: StageSnapshot,
  now = Date.now(),
  trackNode?: StageTrackReadiness,
): TimelineSegment[] {
  const settled = settledKind(stage);
  const failedEvent = stage.events?.some((event) => event.event === "failed") ?? false;
  const bars: TimelineSegment[] = [];
  for (const seg of stageSegments(stage, now, trackNode)) {
    if (seg.endMs <= seg.startMs) continue;
    if (seg.kind === "blocked" || seg.kind === "queued" || seg.kind === "empty") continue;
    const kind: TimelineSegmentKind =
      settled &&
      (seg.kind === "running" || seg.kind === "waiting" || seg.kind === settled)
        ? settled
        : seg.kind === "running" && (stage.status === "failed" || failedEvent)
          ? "failed"
          : seg.kind;
    const prev = bars[bars.length - 1];
    if (prev && prev.kind === kind && seg.startMs <= prev.endMs + 1) {
      prev.endMs = Math.max(prev.endMs, seg.endMs);
      continue;
    }
    bars.push({ kind, startMs: seg.startMs, endMs: seg.endMs });
  }
  return bars;
}

export function futureBarSlots(
  count: number,
  nowPct: number | null,
): { left: number; width: number }[] {
  if (count <= 0) return [];
  const gap = 0.6;
  const maxWidth = 6;
  const origin = nowPct == null ? Math.max(0, 100 - count * maxWidth) : nowPct + gap;
  const room = Math.max(0, 100 - origin);
  const gapTotal = gap * Math.max(0, count - 1);
  const width =
    room <= gapTotal ? room / count : Math.min(maxWidth, (room - gapTotal) / count);
  const stride = width + (count > 1 && room > gapTotal ? gap : 0);
  return Array.from({ length: count }, (_, index) => ({
    left: origin + index * stride,
    width,
  }));
}
