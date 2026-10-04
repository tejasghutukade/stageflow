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

export type WorkshopToolActivityRow = {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  target?: string;
  errorMessage?: string;
  textOffset: number;
};

export type InterleavedAssistantSegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: WorkshopToolActivityRow[] };

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

export function interleaveAssistantTextWithTools(
  text: string,
  tools: readonly WorkshopToolActivityRow[],
): InterleavedAssistantSegment[] {
  if (tools.length === 0) {
    return text ? [{ kind: "text", text }] : [];
  }

  const sorted = [...tools].sort((a, b) => a.textOffset - b.textOffset);
  const groups: Array<{ offset: number; calls: WorkshopToolActivityRow[] }> = [];
  for (const call of sorted) {
    const offset = Math.max(0, Math.min(call.textOffset, text.length));
    const last = groups[groups.length - 1];
    if (last && last.offset === offset) {
      last.calls.push({ ...call, textOffset: offset });
    } else {
      groups.push({ offset, calls: [{ ...call, textOffset: offset }] });
    }
  }

  const segments: InterleavedAssistantSegment[] = [];
  let cursor = 0;
  for (const group of groups) {
    if (group.offset > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, group.offset) });
    }
    segments.push({ kind: "tools", calls: group.calls });
    cursor = group.offset;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  } else if (segments.length === 0 && text) {
    segments.push({ kind: "text", text });
  }
  return segments;
}
