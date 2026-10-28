import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  useAui,
  useAuiState,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { ChatApiError } from "../../chat/api";
import { createThreadListAdapter, toChatError, type ChatMessageError } from "../../chat/adapters";
import { navigate, guidePath } from "../../routes";
import { createGuideApi, toGuideParts, type GuideApi, type GuideSendInput, type GuideStoredMessage } from "./api";
import { applyGuideFrame, finalGuideContent, type GuideContentPart } from "./content";
import { guideUrlAfterNewChat, guideUrlAfterSession } from "./guideUrl";
import { GuideTextAttachmentAdapter } from "./textAttachment";

const LIST_POLL_MS = 1750;
const RESUME_POLL_MS = 1500;

type GuideModelValue = {
  model: string | null;
  setModel: (model: string | null) => void;
};

type GuideActivityValue = {
  runningIds: ReadonlySet<string>;
  isResuming: boolean;
  stopCurrent: () => Promise<void>;
};

const GuideModelContext = createContext<GuideModelValue | null>(null);
const GuideResumeRequestContext = createContext<((threadId: string) => void) | null>(null);
const GuideActivityContext = createContext<GuideActivityValue | null>(null);

export function useGuideModel(): GuideModelValue {
  const value = useContext(GuideModelContext);
  if (!value) throw new Error("Guide model is only available in Guide chat");
  return value;
}

export function useGuideActivity(): GuideActivityValue {
  const value = useContext(GuideActivityContext);
  if (!value) throw new Error("Guide activity is only available in Guide chat");
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
  const requestResume = useContext(GuideResumeRequestContext);
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
        if (detail.status === "running") requestResume?.(remoteId);
        return ExportedMessageRepository.fromArray(detail.messages.map(toGuideThreadMessage));
      },
      async append() {},
    };
    return { model: createGuideModelAdapter(api, threadId, modelRef), history, attachments };
  }, [api, aui, attachments, modelRef, requestResume]);
  return useLocalRuntime(adapters.model, { adapters: { history: adapters.history, attachments: adapters.attachments } });
}

function GuideActivityInner({
  api,
  threadId,
  runningIds,
  setRunningIds,
  resumeId,
  setResumeId,
  children,
}: {
  api: GuideApi;
  threadId?: string;
  runningIds: ReadonlySet<string>;
  setRunningIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  resumeId: string | null;
  setResumeId: Dispatch<SetStateAction<string | null>>;
  children: ReactNode;
}) {
  const aui = useAui();
  const localRunning = useAuiState((state) => state.thread.isRunning);
  const remoteId = useAuiState((state) => state.threadListItem.remoteId) ?? threadId;

  useEffect(() => {
    if (localRunning && resumeId) setResumeId(null);
  }, [localRunning, resumeId, setResumeId]);

  useEffect(() => {
    if (!remoteId || localRunning || resumeId === remoteId) return;
    if (runningIds.has(remoteId)) setResumeId(remoteId);
  }, [remoteId, localRunning, runningIds, resumeId, setResumeId]);

  useEffect(() => {
    if (!resumeId || localRunning) return;
    let live = true;
    let timer = 0;
    const tick = async () => {
      try {
        const detail = await api.getThread(resumeId);
        if (!live) return;
        if (detail.status === "open") {
          aui.thread().import(ExportedMessageRepository.fromArray(detail.messages.map(toGuideThreadMessage)));
          setResumeId(null);
          setRunningIds((prev) => {
            if (!prev.has(resumeId)) return prev;
            const next = new Set(prev);
            next.delete(resumeId);
            return next;
          });
          return;
        }
      } catch {
        // keep polling
      }
      if (live) timer = window.setTimeout(() => void tick(), RESUME_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, aui, localRunning, resumeId, setResumeId, setRunningIds]);

  const stopCurrent = useCallback(async () => {
    const id = remoteId;
    if (!id) return;
    try {
      await api.stopTurn(id);
    } catch {
      // local cancel still clears an in-flight stream
    }
    if (localRunning) aui.composer.cancel();
    if (resumeId !== id) setResumeId(id);
  }, [api, aui, localRunning, remoteId, resumeId, setResumeId]);

  const isResuming = Boolean(resumeId && resumeId === remoteId && !localRunning);
  const value = useMemo<GuideActivityValue>(
    () => ({ runningIds, isResuming, stopCurrent }),
    [runningIds, isResuming, stopCurrent],
  );

  return <GuideActivityContext.Provider value={value}>{children}</GuideActivityContext.Provider>;
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
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  const [resumeId, setResumeId] = useState<string | null>(null);
  const requestResume = useCallback((id: string) => {
    setResumeId(id);
  }, []);

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
        if (detail.status === "running") setResumeId(threadId);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, threadId]);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = async () => {
      const threads = await api.listThreads();
      if (!live) return;
      setRunningIds(new Set(threads.filter((thread) => thread.status === "running").map((thread) => thread.id)));
      timer = window.setTimeout(() => void tick(), LIST_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api]);

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
      <GuideResumeRequestContext.Provider value={requestResume}>
        <AssistantRuntimeProvider runtime={runtime}>
          <GuideActivityInner
            api={api}
            threadId={threadId}
            runningIds={runningIds}
            setRunningIds={setRunningIds}
            resumeId={resumeId}
            setResumeId={setResumeId}
          >
            {children}
          </GuideActivityInner>
        </AssistantRuntimeProvider>
      </GuideResumeRequestContext.Provider>
    </GuideModelContext.Provider>
  );
}
