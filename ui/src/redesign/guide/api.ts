import { authorizationHeaders, notifyControlTokenRequired } from "../../api/controlToken";
import { ChatApiError, type ChatApi, type ChatAgentInfo, type ChatThreadDetail, type ChatThreadSummary } from "../../chat/api";
import { readFrames, toFrame, type ChatFrame, type ChatMessageRecord } from "../../chat/ndjson";

export type {
  GuideLink,
  GuideLinkKind,
  GuidePipelineStage,
  GuideUi,
} from "@stageflow/guide-card-contract";

const ROOT = "/api/guide";

export type GuideAttachmentInput = { name: string; mediaType: string; content: string };

export type GuideToolStatus = "running" | "complete" | "error";

export type GuideToolFrame = {
  type: "tool";
  id: string;
  name: string;
  status: GuideToolStatus;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type GuidePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      status: "complete" | "error";
      args?: Record<string, unknown>;
      result?: unknown;
      error?: string;
    };

export type GuideMessageRecord = ChatMessageRecord & { parts?: GuidePart[] };

export type GuideFrame = Exclude<ChatFrame, { type: "done" }> | { type: "done"; message: GuideMessageRecord } | GuideToolFrame;

export type GuideStoredMessage = GuideMessageRecord & {
  attachments?: { name: string; size: number; mediaType: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolFields(value: Record<string, unknown>) {
  return {
    id: value.id as string,
    name: value.name as string,
    ...(isRecord(value.args) ? { args: value.args } : {}),
    ...("result" in value ? { result: value.result } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

/** Keeps the well-formed parts of a stored or returned assistant message; returns undefined when there are none. */
export function toGuideParts(value: unknown): GuidePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item): GuidePart[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text") return typeof item.text === "string" ? [{ type: "text", text: item.text }] : [];
    if (item.type !== "tool" || typeof item.id !== "string" || typeof item.name !== "string") return [];
    if (item.status !== "complete" && item.status !== "error") return [];
    return [{ type: "tool", status: item.status, ...toolFields(item) }];
  });
  return parts.length > 0 ? parts : undefined;
}

/** Validates one decoded line of a Guide turn; unknown frames are dropped. */
export function toGuideFrame(value: unknown): GuideFrame | null {
  if (!isRecord(value)) return null;
  if (value.type === "tool") {
    if (typeof value.id !== "string" || typeof value.name !== "string") return null;
    if (value.status !== "running" && value.status !== "complete" && value.status !== "error") return null;
    return { type: "tool", status: value.status, ...toolFields(value) };
  }
  const frame = toFrame(value);
  if (frame?.type !== "done") return frame;
  const parts = toGuideParts(isRecord(value.message) ? value.message.parts : undefined);
  return parts ? { type: "done", message: { ...frame.message, parts } } : frame;
}

export type GuideSendInput = {
  text: string;
  attachments: GuideAttachmentInput[];
  model?: string;
};

export type GuideThreadDetail = Omit<ChatThreadDetail, "messages"> & {
  messages: GuideStoredMessage[];
  model: string | null;
};

export type GuideApi = Omit<ChatApi, "getThread"> & {
  getThread: (id: string) => Promise<GuideThreadDetail>;
  sendTurn: (id: string, input: GuideSendInput, signal?: AbortSignal) => AsyncGenerator<GuideFrame, void>;
  updateThreadModel: (id: string, model: string | null) => Promise<{ thread: ChatThreadSummary; model: string | null }>;
};

async function errorFrom(response: Response): Promise<ChatApiError> {
  let body: { code?: unknown; message?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // not JSON
  }
  const code = typeof body.code === "string" ? body.code : "guide.failed";
  return new ChatApiError(code, response.status, typeof body.message === "string" ? body.message : "");
}

/** Console chat API for the Stageflow guide. */
export function createGuideApi(fetchImpl: typeof fetch = fetch): GuideApi {
  const call = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${ROOT}${path}`, {
      ...init,
      headers: {
        ...authorizationHeaders(),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await call(path, init);
    if (response.status === 401) notifyControlTokenRequired();
    if (!response.ok) throw await errorFrom(response);
    return (await response.json()) as T;
  }

  async function* sendTurn(id: string, input: GuideSendInput, signal?: AbortSignal): AsyncGenerator<GuideFrame, void> {
    const response = await call(`/threads/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text: input.text,
        attachments: input.attachments,
        ...(input.model ? { model: input.model } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (response.status === 401) notifyControlTokenRequired();
    if (!response.ok) throw await errorFrom(response);
    if (!response.body) throw new ChatApiError("guide.failed", response.status, "");
    yield* readFrames(response.body, toGuideFrame);
  }

  return {
    info: async (): Promise<ChatAgentInfo> => {
      const body = await json<{ agent: ChatAgentInfo }>("");
      return { name: body.agent.name, greeting: body.agent.greeting ?? null };
    },
    listThreads: async (): Promise<ChatThreadSummary[]> => {
      try {
        return (await json<{ threads: ChatThreadSummary[] }>("/threads")).threads;
      } catch {
        return [];
      }
    },
    createThread: async (): Promise<ChatThreadSummary> =>
      (await json<{ thread: ChatThreadSummary }>("/threads", { method: "POST", body: "{}" })).thread,
    getThread: async (id: string): Promise<GuideThreadDetail> => {
      const detail = await json<GuideThreadDetail & { model?: string | null }>(
        `/threads/${encodeURIComponent(id)}`,
      );
      return { ...detail, model: detail.model ?? null };
    },
    updateThreadModel: (id: string, model: string | null) =>
      json<{ thread: ChatThreadSummary; model: string | null }>(`/threads/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ model }),
      }),
    async *sendMessage(id, text, signal) {
      for await (const frame of sendTurn(id, { text, attachments: [] }, signal)) {
        if (frame.type !== "tool") yield frame;
      }
    },
    sendTurn,
  };
}
