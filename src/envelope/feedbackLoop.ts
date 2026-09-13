import { EnvelopeError, type StageEnvelope } from "../types/envelope.js";
import type { FeedbackLoopConfig } from "../types/pipeline.js";

/** Validates an action against the source stage's declared feedback-loop policy. */
export function assertFeedbackLoopAction(
  envelope: StageEnvelope,
  context: FeedbackLoopConfig | undefined,
): void {
  if (context === undefined) {
    if (envelope.feedback_loop !== undefined) {
      throw new EnvelopeError("feedback_loop is only allowed for a configured feedback-loop stage");
    }
    return;
  }

  if (envelope.status === "failure") {
    if (envelope.feedback_loop !== undefined) {
      throw new EnvelopeError("feedback_loop action is not allowed when status is failure");
    }
    return;
  }

  const action = envelope.feedback_loop;
  if (action === undefined) {
    throw new EnvelopeError("feedback_loop action is required for a successful feedback-loop stage");
  }
  if (action.action === "continue") return;
  if (envelope.fork_choice !== undefined) {
    throw new EnvelopeError(
      "feedback_loop send_back cannot be combined with fork_choice",
    );
  }
  if (action.target !== context.target) {
    throw new EnvelopeError(
      `feedback_loop.target "${action.target}" is not an allowed feedback-loop target`,
    );
  }
}
