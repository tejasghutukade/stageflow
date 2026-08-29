import type { RunStatus, RunSummary, StageSnapshot } from "../api";

export type RunDisplayStatus = RunStatus | "waiting_for_input";
export type StageDisplayStatus = StageSnapshot["status"];
export type DisplayStatus = RunDisplayStatus | StageDisplayStatus;

export type CssStatusToken = "waiting" | "running" | "succeeded" | "failed";
export type RingStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

export function runDisplayStatus(run: RunSummary): RunDisplayStatus {
  if (run.waiting_stage_id) return "waiting_for_input";
  return run.status;
}

export function cssStatusToken(status: DisplayStatus): CssStatusToken | undefined {
  switch (status) {
    case "waiting_for_input":
      return "waiting";
    case "created":
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "pending":
    case "skipped":
      return undefined;
  }
}

export function statusCopy(status: DisplayStatus): string {
  switch (status) {
    case "waiting_for_input":
      return "waiting on you";
    case "created":
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "skipped":
      return status;
  }
}

export function waitingOnYouTitle(): string {
  const copy = statusCopy("waiting_for_input");
  return copy.charAt(0).toUpperCase() + copy.slice(1);
}

export function ringStatus(status: StageDisplayStatus): RingStatus {
  switch (status) {
    case "waiting_for_input":
      return "waiting";
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "skipped":
      return status;
  }
}

export function ringGlyph(status: StageDisplayStatus | RingStatus): string {
  switch (status) {
    case "waiting_for_input":
    case "waiting":
      return "?";
    case "pending":
      return "";
    case "running":
      return "▸";
    case "succeeded":
      return "✓";
    case "failed":
      return "✕";
    case "skipped":
      return "–";
  }
}

export function trackSegmentToken(
  status: StageDisplayStatus,
): CssStatusToken | "skipped" | undefined {
  if (status === "skipped") return "skipped";
  return cssStatusToken(status);
}

export function statusDotVariant(
  status: DisplayStatus,
): "success" | "warning" | "error" | "accent" | "neutral" {
  switch (status) {
    case "created":
    case "pending":
    case "skipped":
      return "neutral";
    case "running":
      return "accent";
    case "waiting_for_input":
      return "warning";
    case "succeeded":
      return "success";
    case "failed":
      return "error";
  }
}

export function statusIsPulsing(status: DisplayStatus): boolean {
  return status === "running";
}
