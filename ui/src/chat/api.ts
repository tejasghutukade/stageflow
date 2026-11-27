import { toLimitKind, UNAVAILABLE_CODE, type ChatLimitKind } from "./errors";
import { messageParts, readFrames, type ChatFrame, type ChatMessageRecord } from "./ndjson";

export type ChatThreadSummary = { id: string; title: string; updatedAt: string };
export type ChatThreadDetail = {
  thread: ChatThreadSummary;
  status: "open" | "running" | "waiting";
  messages: ChatMessageRecord[];
};
export type ChatAgentInfo = { name: string; greeting: string | null; sandboxOrigins?: string[] };

export class ChatApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
    readonly limit?: ChatLimitKind,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

export type ChatApi = ReturnType<typeof createChatApi>;

export type ChatApiOptions = {
  apiBase: string;
  slug: string;
  visitorId: string;
  fetchImpl?: typeof fetch;
};

async function errorFrom(response: Response): Promise<ChatApiError> {
  let body: { code?: unknown; message?: unknown; retryAfterSec?: unknown; limit?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // not JSON; fall back to the status
  }
  const code = typeof body.code === "string" ? body.code : response.status === 404 ? UNAVAILABLE_CODE : "web_chat.failed";
  const retry = typeof body.retryAfterSec === "number" ? body.retryAfterSec : Number(response.headers.get("retry-after")) || undefined;
  return new ChatApiError(code, response.status, typeof body.message === "string" ? body.message : "", retry, toLimitKind(body.limit));
}

/** The whole public chat API, scoped to one agent slug and one visitor. */
export function createChatApi({ apiBase, slug, visitorId, fetchImpl }: ChatApiOptions) {
  const base = `${apiBase}/${encodeURIComponent(slug)}`;
  const call = (path: string, init: RequestInit = {}) =>
    (fetchImpl ?? fetch)(`${base}${path}`, {
      ...init,
      headers: { "x-visitor-id": visitorId, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await call(path, init);
    if (!response.ok) throw await errorFrom(response);
    return (await response.json()) as T;
  }

  return {
    info: async (): Promise<ChatAgentInfo> => {
      const body = await json<{ agent: ChatAgentInfo }>("");
      const origins = Array.isArray(body.agent.sandboxOrigins) ? body.agent.sandboxOrigins.filter((origin): origin is string => typeof origin === "string") : [];
      return { name: body.agent.name, greeting: body.agent.greeting ?? null, ...(origins.length > 0 ? { sandboxOrigins: origins } : {}) };
    },
    listThreads: async (): Promise<ChatThreadSummary[]> => (await json<{ threads: ChatThreadSummary[] }>("/threads")).threads,
    createThread: async (): Promise<ChatThreadSummary> => (await json<{ thread: ChatThreadSummary }>("/threads", { method: "POST", body: "{}" })).thread,
    getThread: async (id: string): Promise<ChatThreadDetail> => {
      const detail = await json<Omit<ChatThreadDetail, "messages"> & { messages: (ChatMessageRecord & { parts?: unknown })[] }>(`/threads/${encodeURIComponent(id)}`);
      return {
        ...detail,
        messages: detail.messages.map(({ parts, ...record }) => {
          const ui = messageParts(parts);
          return ui ? { ...record, ui } : record;
        }),
      };
    },
    /** Streams the reply. Errors before streaming throw ChatApiError; errors during it arrive as an `error` frame. */
    async *sendMessage(id: string, text: string, signal?: AbortSignal): AsyncGenerator<ChatFrame, void> {
      const response = await call(`/threads/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await errorFrom(response);
      if (!response.body) throw new ChatApiError("web_chat.failed", response.status, "");
      yield* readFrames(response.body);
    },
  };
}
