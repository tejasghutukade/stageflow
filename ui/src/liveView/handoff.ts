import type { PendingPrompt } from "../api/types";

export function liveViewHandoffUrl(prompt: Pick<PendingPrompt, "handoff">): string | null {
  const handoff = prompt.handoff;
  return handoff?.kind === "live_view" ? handoff.url : null;
}

export function watchBrowserUrl(runId: string, stageId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/live-view`;
}

export function canWatchBrowser(status: string): boolean {
  return status === "running" || status === "waiting_for_input";
}
