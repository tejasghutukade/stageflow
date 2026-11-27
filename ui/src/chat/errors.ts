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

/**
 * What the page says when the chat cannot open. `code` is null when the request never reached the Host.
 * Visitors are told plainly what is wrong and who can fix it; the owner is pointed at the agent's page in the console.
 */
export function loadErrorMessage(code: string | null): { title: string; body: string } {
  switch (code) {
    case null:
      return { title: "We couldn't reach this chat", body: "Please check your connection and refresh the page." };
    case "identity.setup_required":
      return {
        title: "This chat isn't open to the public yet",
        body: "The agent behind this link can do more than chat, so it can't answer anonymous visitors. If it's your agent, open it in the Stageflow console: its page says what to change.",
      };
    case "identity.verification_required":
      return { title: "Sign in to use this chat", body: "This chat is only for signed-in customers. Open it from the site that gave you the link." };
    case "identity.not_available":
      return { title: "This chat isn't available to you", body: "Your account can't use this chat. Contact the people who sent you the link." };
    case "web_chat.forbidden_origin":
      return { title: "This chat can't be opened here", body: "It only works on the site it was set up for." };
    case "web_chat.rate_limited":
      return { title: "Too many requests", body: "Please wait a moment and refresh the page." };
    default:
      return { title: "This chat ran into a problem", body: "Please refresh the page. If it keeps happening, tell the people who sent you the link." };
  }
}
