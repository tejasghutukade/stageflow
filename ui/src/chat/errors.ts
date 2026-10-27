export const UNAVAILABLE_CODE = "web_chat.unavailable";

export type ChatErrorInfo = { code: string; message: string; retryAfterSec?: number };

/** What a visitor reads for each error code. Server messages are never shown: only the code decides. */
export function friendlyMessage(code: string, retryAfterSec?: number): string {
  switch (code) {
    case "web_chat.rate_limited":
      return retryAfterSec && retryAfterSec > 0
        ? "You're sending messages too quickly. Please wait a moment and try again."
        : "You're sending messages too quickly. Please try again shortly.";
    case "web_chat.message_too_long":
      return "That message is too long. Please shorten it and try again.";
    case "web_chat.busy":
      return "The assistant is still replying. Please wait for it to finish.";
    case "web_chat.limit_reached":
      return "This conversation has reached its limit. Start a new one.";
    case "guide.message_too_long":
      return "That message is too long. Please shorten it and try again.";
    case "guide.busy":
      return "Stageflow is still replying. Please wait for it to finish.";
    case "guide.not_found":
      return "This conversation is no longer available. Start a new chat.";
    case "guide.invalid":
      return "That message couldn't be sent.";
    case "guide.attachment":
      return "Those files couldn't be attached. Use up to 5 text files, 256 KB each.";
    case "guide.unavailable":
      return "Stageflow isn't available right now.";
    case UNAVAILABLE_CODE:
      return "This chat isn't available right now.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** True when the code means the visitor should begin a new conversation rather than retry. */
export function needsNewConversation(code: string): boolean {
  return code === "web_chat.limit_reached";
}
