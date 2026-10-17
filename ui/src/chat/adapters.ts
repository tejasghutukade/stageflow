import type { ChatModelAdapter, ChatModelRunResult, RemoteThreadListAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import { ChatApiError, type ChatApi } from "./api";
import { friendlyMessage, type ChatErrorInfo } from "./errors";
import type { ChatMessageRecord } from "./ndjson";

/** Carried on an incomplete assistant message so the UI can render a friendly notice. */
export type ChatMessageError = ChatErrorInfo & { friendly: string };

export function toChatError(code: string, message: string, retryAfterSec?: number): ChatMessageError {
  return { code, message, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}), friendly: friendlyMessage(code, retryAfterSec) };
}

/** The visitor's conversations as the thread list wants them. Rename/archive/delete are not offered to visitors. */
export function createThreadListAdapter(api: ChatApi): RemoteThreadListAdapter {
  return {
    async list() {
      const threads = await api.listThreads();
      return {
        threads: threads.map((thread) => ({
          status: "regular" as const,
          remoteId: thread.id,
          title: thread.title || undefined,
          lastMessageAt: new Date(thread.updatedAt),
        })),
      };
    },
    async initialize() {
      const thread = await api.createThread();
      return { remoteId: thread.id };
    },
    async fetch(remoteId) {
      const { thread } = await api.getThread(remoteId);
      return { status: "regular", remoteId: thread.id, title: thread.title || undefined, lastMessageAt: new Date(thread.updatedAt) };
    },
    async rename() {},
    async archive() {},
    async unarchive() {},
    async delete() {},
    async generateTitle(_remoteId, messages) {
      const first = messages.find((message) => message.role === "user");
      const text = first?.content.map((part) => (part.type === "text" ? part.text : "")).join(" ") ?? "";
      return createAssistantStream((controller) => {
        controller.appendText(titleFrom(text));
      });
    },
  };
}

export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > 48 ? `${flat.slice(0, 47).trimEnd()}…` : flat;
}

export function toThreadMessages(records: readonly ChatMessageRecord[]): ThreadMessageLike[] {
  return records.map((record) => ({
    id: record.id,
    role: record.role,
    content: [{ type: "text" as const, text: record.text }],
    createdAt: new Date(record.createdAt),
    ...(record.role === "assistant" ? { status: { type: "complete" as const, reason: "stop" as const } } : {}),
  }));
}

function userText(options: Parameters<ChatModelAdapter["run"]>[0]): string {
  const last = [...options.messages].reverse().find((message) => message.role === "user");
  return (last?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("").trim();
}

/**
 * Sends the visitor's last message and turns the server's NDJSON frames into assistant-ui updates:
 * deltas accumulate into cumulative text, `waiting` marks the message as waiting on the team, and
 * errors end the message as incomplete with a friendly notice.
 */
export function createChatModelAdapter(api: ChatApi, resolveThreadId: () => Promise<string>): ChatModelAdapter {
  return {
    async *run(options): AsyncGenerator<ChatModelRunResult, void> {
      const text = userText(options);
      if (!text) return;
      let reply = "";
      const content = () => [{ type: "text" as const, text: reply }];
      try {
        const threadId = await resolveThreadId();
        for await (const frame of api.sendMessage(threadId, text, options.abortSignal)) {
          if (frame.type === "delta") {
            reply += frame.text;
            yield { content: content(), metadata: { custom: { waiting: false } } };
          } else if (frame.type === "waiting") {
            yield { content: content(), metadata: { custom: { waiting: true } } };
          } else if (frame.type === "done") {
            yield { content: [{ type: "text", text: frame.message.text }], status: { type: "complete", reason: "stop" }, metadata: { custom: { waiting: false } } };
            return;
          } else {
            yield failure(reply, toChatError(frame.code, frame.message, frame.retryAfterSec));
            return;
          }
        }
        if (reply) yield { content: content(), status: { type: "complete", reason: "stop" }, metadata: { custom: { waiting: false } } };
        else yield failure(reply, toChatError("web_chat.failed", ""));
      } catch (error) {
        if (options.abortSignal.aborted) return;
        const info =
          error instanceof ChatApiError ? toChatError(error.code, error.message, error.retryAfterSec) : toChatError("web_chat.failed", "");
        yield failure(reply, info);
      }
    },
  };
}

function failure(reply: string, error: ChatMessageError): ChatModelRunResult {
  return {
    content: [{ type: "text", text: reply }],
    status: { type: "incomplete", reason: "error", error },
    metadata: { custom: { waiting: false } },
  };
}
