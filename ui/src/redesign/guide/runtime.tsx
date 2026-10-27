import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  useAui,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChatApiError } from "../../chat/api";
import { createThreadListAdapter, toChatError, type ChatMessageError } from "../../chat/adapters";
import { navigate, guidePath } from "../../routes";
import { createGuideApi, toGuideParts, type GuideApi, type GuideSendInput, type GuideStoredMessage } from "./api";
import { applyGuideFrame, finalGuideContent, type GuideContentPart } from "./content";
import { guideUrlAfterNewChat, guideUrlAfterSession } from "./guideUrl";
import { GuideTextAttachmentAdapter } from "./textAttachment";

type GuideModelValue = {
  model: string | null;
  setModel: (model: string | null) => void;
};

const GuideModelContext = createContext<GuideModelValue | null>(null);

export function useGuideModel(): GuideModelValue {
  const value = useContext(GuideModelContext);
  if (!value) throw new Error("Guide model is only available in Guide chat");
  return value;
}

function attachmentBody(text: string): string {
  const wrapped = text.match(/^<attachment name="[^"]*">\n([\s\S]*)\n<\/attachment>$/);
  return (wrapped?.[1] ?? text).trim();
}

function sendInput(options: Parameters<ChatModelAdapter["run"]>[0], model: string | null): GuideSendInput | null {
  const last = [...options.messages].reverse().find((message) => message.role === "user");
  if (!last || last.role !== "user") return null;
  const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
  const attachments = last.attachments.flatMap((file) => {
    const content = attachmentBody(file.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
    if (!content) return [];
    return [{ name: file.name, mediaType: file.contentType || "text/plain", content }];
  });
  if (!text && attachments.length === 0) return null;
  return { text, attachments, ...(model ? { model } : {}) };
}

function createGuideModelAdapter(api: GuideApi, resolveThreadId: () => Promise<string>, modelRef: RefObject<string | null>): ChatModelAdapter {
  return {
    async *run(options): AsyncGenerator<ChatModelRunResult, void> {
      const input = sendInput(options, modelRef.current);
      if (!input) return;
      let content: GuideContentPart[] = [];
      try {
        const threadId = await resolveThreadId();
        for await (const frame of api.sendTurn(threadId, input, options.abortSignal)) {
          if (frame.type === "delta" || frame.type === "tool") {
            content = applyGuideFrame(content, frame);
            yield { content };
          } else if (frame.type === "done") {
            yield { content: finalGuideContent(frame.message, content), status: { type: "complete", reason: "stop" } };
            return;
          } else if (frame.type === "error") {
            yield failure(content, toChatError(frame.code, frame.message, frame.retryAfterSec));
            return;
          }
        }
        if (content.length > 0) yield { content, status: { type: "complete", reason: "stop" } };
        else yield failure(content, toChatError("guide.failed", ""));
      } catch (error) {
        if (options.abortSignal.aborted) return;
        const info = error instanceof ChatApiError ? toChatError(error.code, error.message, error.retryAfterSec) : toChatError("guide.failed", "");
        yield failure(content, info);
      }
    },
  };
}

function failure(content: GuideContentPart[], error: ChatMessageError): ChatModelRunResult {
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    status: { type: "incomplete", reason: "error", error },
  };
}

function toGuideThreadMessage(record: GuideStoredMessage): ThreadMessageLike {
  const attachments = (record.attachments ?? []).map((file) => ({
    id: file.name,
    type: "document" as const,
    name: file.name,
    contentType: file.mediaType,
    status: { type: "complete" as const },
    content: [] as { type: "text"; text: string }[],
  }));
  return {
    id: record.id,
    role: record.role,
    content: record.role === "assistant" ? finalGuideContent({ ...record, parts: toGuideParts(record.parts) }, []) : [{ type: "text" as const, text: record.text }],
    createdAt: new Date(record.createdAt),
    ...(record.role === "assistant" ? { status: { type: "complete" as const, reason: "stop" as const } } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function useConversationRuntime(api: GuideApi, modelRef: RefObject<string | null>) {
  const aui = useAui();
  const attachments = useMemo(() => new GuideTextAttachmentAdapter(), []);
  const adapters = useMemo(() => {
    const threadId = async (): Promise<string> => {
      const item = aui.threadListItem;
      return item.getState().remoteId ?? (await item.initialize()).remoteId;
    };
    const history: ThreadHistoryAdapter = {
      async load() {
        const remoteId = aui.threadListItem.getState().remoteId;
        if (!remoteId) return ExportedMessageRepository.fromArray([]);
        const detail = await api.getThread(remoteId);
        return ExportedMessageRepository.fromArray(detail.messages.map(toGuideThreadMessage));
      },
      async append() {},
    };
    return { model: createGuideModelAdapter(api, threadId, modelRef), history, attachments };
  }, [api, aui, attachments, modelRef]);
  return useLocalRuntime(adapters.model, { adapters: { history: adapters.history, attachments: adapters.attachments } });
}

export function GuideRuntime({
  children,
  threadId,
}: {
  children: ReactNode;
  threadId?: string;
}) {
  const api = useMemo(() => createGuideApi(), []);
  const modelRef = useRef<string | null>(null);
  const [model, setModelState] = useState<string | null>(null);
  const setModel = (next: string | null) => {
    modelRef.current = next;
    setModelState(next);
    if (threadId) {
      void api.updateThreadModel(threadId, next).catch(() => {});
    }
  };
  useEffect(() => {
    let live = true;
    if (!threadId) {
      modelRef.current = null;
      setModelState(null);
      return;
    }
    api.getThread(threadId).then(
      (detail) => {
        if (!live) return;
        const next = detail.model ?? null;
        modelRef.current = next;
        setModelState(next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, threadId]);
  const threadListAdapter = useMemo(() => createThreadListAdapter(api), [api]);
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useConversationRuntime(api, modelRef),
    adapter: threadListAdapter,
    threadId,
    onThreadIdChange: (id) => {
      const next = guidePath(
        "chat",
        id ? guideUrlAfterSession(id) : guideUrlAfterNewChat(),
      );
      if (window.location.hash.replace(/^#/, "") !== next) {
        navigate(next);
      }
    },
  });
  return (
    <GuideModelContext.Provider value={{ model, setModel }}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </GuideModelContext.Provider>
  );
}
