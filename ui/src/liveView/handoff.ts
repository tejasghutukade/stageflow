import type { PendingPrompt } from "../api/types";

export function liveViewHandoffUrl(prompt: Pick<PendingPrompt, "handoff">): string | null {
  const handoff = prompt.handoff;
  return handoff?.kind === "live_view" ? handoff.url : null;
}
