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
