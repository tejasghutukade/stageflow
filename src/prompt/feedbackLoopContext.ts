import type { FeedbackLoopContext } from "../agent/port.js";

export function formatFeedbackLoopContext(ctx: FeedbackLoopContext): string {
  return `Feedback Loop Context:\n${JSON.stringify(ctx, null, 2)}`;
}
