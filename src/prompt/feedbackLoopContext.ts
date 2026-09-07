import type { FeedbackLoopContext, StageSessionMode } from "../agent/port.js";

function resolveFeedbackSessionMode(
  ctx: FeedbackLoopContext,
  sessionMode?: StageSessionMode,
): "feedback_resume" | "new_session" {
  if (sessionMode === "new_session" || sessionMode === "feedback_resume") {
    return sessionMode;
  }
  return ctx.replay_session === "new_session" ? "new_session" : "feedback_resume";
}

export function formatFeedbackLoopContext(
  ctx: FeedbackLoopContext,
  sessionMode?: StageSessionMode,
): string {
  const mode = resolveFeedbackSessionMode(ctx, sessionMode);
  const continuity =
    mode === "new_session"
      ? "starting a fresh agent session"
      : "continuing the prior agent session";
  return [
    "Feedback Loop Context:",
    `Session mode: ${mode} (${continuity})`,
    JSON.stringify(ctx, null, 2),
  ].join("\n");
}
