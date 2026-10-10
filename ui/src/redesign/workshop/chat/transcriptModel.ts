import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  CHAT_FAILED_PREFIX,
  interleaveAssistantTextWithTools,
  mapWorkshopChatParts,
  type InterleavedAssistantSegment,
  type WorkshopChatMessageInput,
  type WorkshopChatMutationCardInput,
  type WorkshopToolActivityRow,
} from "../../../workshop/workshopChatView";
import { attachmentMetaList, type WorkshopAttachmentMeta } from "./attachments";

export type TranscriptMessageInput = WorkshopChatMessageInput & {
  id?: string;
  createdAt?: Date | string | null;
  metadata?: { custom?: Record<string, unknown> } | null;
};

export type TranscriptUserTurn = {
  kind: "user";
  key: string;
  text: string;
  createdAt: Date | null;
  attachments: WorkshopAttachmentMeta[];
};

export type TranscriptAgentTurn = {
  kind: "agent";
  key: string;
  createdAt: Date | null;
  segments: InterleavedAssistantSegment[];
  mutations: WorkshopChatMutationCardInput[];
  failed: boolean;
  streaming: boolean;
  working: boolean;
};

export type TranscriptSystemTurn = { kind: "system"; key: string; text: string };

export type TranscriptTurn = TranscriptUserTurn | TranscriptAgentTurn | TranscriptSystemTurn;

const STREAM_PLACEHOLDER = "…";

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasVisibleText(segments: readonly InterleavedAssistantSegment[]): boolean {
  return segments.some(
    (segment) =>
      segment.kind === "text" &&
      segment.text.trim().length > 0 &&
      segment.text.trim() !== STREAM_PLACEHOLDER,
  );
}

export function buildTranscript(input: {
  messages: readonly TranscriptMessageInput[];
  toolActivity?: readonly WorkshopToolActivityRow[];
  isRunning: boolean;
}): TranscriptTurn[] {
  const { messages, isRunning } = input;
  const toolActivity = input.toolActivity ?? [];
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
  });
  let currentAssistantIndex = -1;
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    if (messages[index]!.role === "assistant") {
      currentAssistantIndex = index;
      break;
    }
  }

  const turns: TranscriptTurn[] = [];
  messages.forEach((message, index) => {
    const key = message.id ?? `m-${index}`;
    const parts = mapWorkshopChatParts([message]);
    const text = parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("");
    const mutations = parts.filter(
      (part): part is WorkshopChatMutationCardInput => part.kind === "draft_mutation",
    );
    const createdAt = toDate(message.createdAt);

    if (message.role === "user") {
      turns.push({
        kind: "user",
        key,
        text,
        createdAt,
        attachments: attachmentMetaList(message.metadata?.custom?.attachments),
      });
      return;
    }
    if (message.role === "system") {
      if (text) turns.push({ kind: "system", key, text });
      return;
    }

    const isCurrent = index === currentAssistantIndex;
    const visibleText = text === STREAM_PLACEHOLDER ? "" : text;
    const segments =
      isCurrent && toolActivity.length > 0
        ? interleaveAssistantTextWithTools(visibleText, toolActivity)
        : visibleText
          ? [{ kind: "text" as const, text: visibleText }]
          : [];
    const streaming = isCurrent && isRunning;
    turns.push({
      kind: "agent",
      key,
      createdAt,
      segments,
      mutations,
      failed: text.startsWith(CHAT_FAILED_PREFIX),
      streaming,
      working: streaming && !hasVisibleText(segments) && toolActivity.length === 0,
    });
  });

  if (currentAssistantIndex < 0 && lastUserIndex >= 0 && (isRunning || toolActivity.length > 0)) {
    turns.push({
      kind: "agent",
      key: "pending-agent",
      createdAt: null,
      segments: toolActivity.length > 0 ? [{ kind: "tools", calls: [...toolActivity] }] : [],
      mutations: [],
      failed: false,
      streaming: isRunning,
      working: isRunning && toolActivity.length === 0,
    });
  }

  return turns;
}

export function formatClock(date: Date | null): string | null {
  if (!date) return null;
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function userMetaLine(date: Date | null): string {
  const clock = formatClock(date);
  return clock ? `you · ${clock}` : "you";
}

export type WorkshopSeedTranscriptMessage = {
  role: string;
  text: string;
  createdAt?: string;
  attachments?: ReadonlyArray<{ name: string; size?: number; mediaType?: string }>;
};

export function workshopSeedMessages(
  transcript: readonly WorkshopSeedTranscriptMessage[],
): ThreadMessageLike[] {
  return transcript.map((message) => {
    const role =
      message.role === "user" || message.role === "system" || message.role === "assistant"
        ? message.role
        : "assistant";
    const createdAt = toDate(message.createdAt);
    const attachments = attachmentMetaList(message.attachments);
    return {
      role,
      content: message.text,
      ...(createdAt ? { createdAt } : {}),
      ...(role === "user" && attachments.length > 0
        ? { metadata: { custom: { attachments } } }
        : {}),
    };
  });
}
