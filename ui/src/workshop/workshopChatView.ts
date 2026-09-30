import {
  DRAFT_MUTATION_TOOL_NAME,
  type DraftMutationToolPart,
} from "./draftMutationTools";

export const CHAT_FAILED_PREFIX = "Chat failed:";

export function maySend(text: string): boolean {
  return text.trim().length > 0;
}

export type WorkshopChatTextBody = {
  kind: "text";
  role: "user" | "assistant" | "system";
  text: string;
};

export type WorkshopChatMutationCardInput = {
  kind: "draft_mutation";
  toolCallId: string;
  args: DraftMutationToolPart["args"];
};

export type WorkshopChatViewPart =
  | WorkshopChatTextBody
  | WorkshopChatMutationCardInput;

export type WorkshopChatPartInput = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  argsText?: string;
};

export type WorkshopChatMessageInput = {
  role: string;
  content: string | readonly WorkshopChatPartInput[];
};

function normalizeRole(role: string): "user" | "assistant" | "system" {
  if (role === "user" || role === "system" || role === "assistant") return role;
  return "assistant";
}

function asParts(
  content: string | readonly WorkshopChatPartInput[],
): readonly WorkshopChatPartInput[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content;
}

function mutationArgsFrom(
  args: WorkshopChatPartInput["args"],
): WorkshopChatMutationCardInput["args"] | null {
  if (!args || typeof args !== "object") return null;
  const mutationId =
    typeof args.mutationId === "string" ? args.mutationId : "";
  const summary = typeof args.summary === "string" ? args.summary : "";
  const affectedStageIds = Array.isArray(args.affectedStageIds)
    ? args.affectedStageIds.filter((id): id is string => typeof id === "string")
    : [];
  if (!mutationId) return null;
  return { mutationId, summary, affectedStageIds };
}

export function mapWorkshopChatParts(
  messages: readonly WorkshopChatMessageInput[],
): WorkshopChatViewPart[] {
  const out: WorkshopChatViewPart[] = [];

  for (const message of messages) {
    const role = normalizeRole(message.role);
    const parts = asParts(message.content);
    const textParts = parts.filter(
      (part): part is WorkshopChatPartInput & { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    );
    const failure = textParts.find((part) =>
      part.text.startsWith(CHAT_FAILED_PREFIX),
    );
    if (failure) {
      out.push({ kind: "text", role, text: failure.text });
      continue;
    }

    const text = textParts.map((part) => part.text).join("");
    if (text) out.push({ kind: "text", role, text });

    for (const part of parts) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== DRAFT_MUTATION_TOOL_NAME) continue;
      const args = mutationArgsFrom(part.args);
      if (!args) continue;
      out.push({
        kind: "draft_mutation",
        toolCallId:
          typeof part.toolCallId === "string" && part.toolCallId
            ? part.toolCallId
            : `mutation-${args.mutationId}`,
        args,
      });
    }
  }

  return out;
}
