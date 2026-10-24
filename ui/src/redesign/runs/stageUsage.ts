import type { CapacityHealth, StageSnapshot } from "../../api";

export function stagePrimaryModel(stage: Pick<StageSnapshot, "usage">): string | null {
  const models = stage.usage?.models;
  if (!models) return null;
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, b] of Object.entries(models)) {
    const tokens = b.inputTokens + b.outputTokens;
    if (tokens > bestTokens) {
      best = model;
      bestTokens = tokens;
    }
  }
  return best;
}

export function stageTokenTotals(
  stage: Pick<StageSnapshot, "usage">,
): { input: number; output: number } | null {
  const models = stage.usage?.models;
  if (!models || Object.keys(models).length === 0) return null;
  let input = 0;
  let output = 0;
  for (const b of Object.values(models)) {
    input += b.inputTokens + b.cacheReadInputTokens + b.cacheCreationInputTokens;
    output += b.outputTokens;
  }
  return { input, output };
}

export type StageContextUsage = { tokens: number; contextWindow: number; percent: number };

/** Latest context fill the agent reported for this stage, or null before its first response. */
export function stageContextUsage(stage: Pick<StageSnapshot, "events">): StageContextUsage | null {
  for (let i = stage.events.length - 1; i >= 0; i--) {
    const ev = stage.events[i];
    if (ev.event !== "context_usage") continue;
    const { tokens, contextWindow, percent } = ev;
    if (
      typeof tokens === "number" &&
      typeof contextWindow === "number" &&
      typeof percent === "number" &&
      contextWindow > 0
    ) {
      return { tokens, contextWindow, percent };
    }
  }
  return null;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function firstEventAt(stage: Pick<StageSnapshot, "events">, name: string): string | null {
  for (const ev of stage.events) {
    if (ev.event === name && ev.at) return ev.at;
  }
  return null;
}

function lastEventAt(stage: Pick<StageSnapshot, "events">, name: string): string | null {
  for (let i = stage.events.length - 1; i >= 0; i--) {
    const ev = stage.events[i];
    if (ev.event === name && ev.at) return ev.at;
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function stageStartedClock(stage: Pick<StageSnapshot, "events">): string | null {
  const at = firstEventAt(stage, "started");
  if (!at) return null;
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return null;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatWaitDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${pad2(sec % 60)}s`;
  return `${Math.floor(min / 60)}h ${pad2(min % 60)}m`;
}

export function stageWaitingMs(
  stage: Pick<StageSnapshot, "events">,
  now = Date.now(),
): number | null {
  const at = lastEventAt(stage, "waiting_for_input");
  if (!at) return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, now - ms);
}

export function runSlotLabel(
  runId: string,
  health: Pick<CapacityHealth, "activeRunIds" | "maxConcurrent"> | null,
): string | null {
  const index = health?.activeRunIds?.indexOf(runId) ?? -1;
  if (index < 0) return null;
  const max = health?.maxConcurrent;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) {
    return `slot ${index + 1} of ${max}`;
  }
  return "holding a slot";
}
