import { describe, expect, it, vi } from "vitest";
import { createChatModelAdapter, createThreadListAdapter, titleFrom, toThreadMessages } from "./adapters";
import { ChatApiError, createChatApi, type ChatApi } from "./api";
import { DEFAULT_API_BASE, readChatConfig } from "./config";
import { friendlyMessage, needsNewConversation } from "./errors";
import { readFrames, toFrame, type ChatFrame } from "./ndjson";
import { getVisitorId, newVisitorId, resetVisitorMemoForTests } from "./visitor";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ChatFrame[]> {
  const frames: ChatFrame[] = [];
  for await (const frame of readFrames(stream)) frames.push(frame);
  return frames;
}

describe("NDJSON frames", () => {
  it("parses frames split across chunks and a final line with no newline", async () => {
    const done = JSON.stringify({ type: "done", message: { id: "m1", role: "assistant", text: "hi there", createdAt: "2026-10-16T00:00:00.000Z" } });
    const frames = await collect(streamOf('{"type":"delta","te', 'xt":"hi"}\n{"type":"waiting"}\n', done));
    expect(frames).toEqual([
      { type: "delta", text: "hi" },
      { type: "waiting" },
      { type: "done", message: { id: "m1", role: "assistant", text: "hi there", createdAt: "2026-10-16T00:00:00.000Z" } },
    ]);
  });

  it("decodes multibyte text that straddles a chunk boundary", async () => {
    const bytes = new TextEncoder().encode('{"type":"delta","text":"héllo €"}\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 22));
        controller.enqueue(bytes.slice(22));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual([{ type: "delta", text: "héllo €" }]);
  });

  it("skips blank, malformed and unknown lines", async () => {
    const frames = await collect(streamOf('\n{"type":"mystery"}\nnot json\n{"type":"delta","text":"ok"}\n{"type":"delta"}\n'));
    expect(frames).toEqual([{ type: "delta", text: "ok" }]);
  });

  it("reads error frames with retry-after", () => {
    expect(toFrame({ type: "error", code: "web_chat.rate_limited", message: "slow", retryAfterSec: 12 })).toEqual({
      type: "error",
      code: "web_chat.rate_limited",
      message: "slow",
      retryAfterSec: 12,
    });
    expect(toFrame({ type: "error" })).toEqual({ type: "error", code: "web_chat.failed", message: "" });
  });
});

describe("friendly errors", () => {
  it("never echoes server text and maps each code", () => {
    expect(friendlyMessage("web_chat.limit_reached")).toBe("This conversation has reached its limit. Start a new one.");
    expect(friendlyMessage("web_chat.rate_limited", 5)).toContain("too quickly");
    expect(friendlyMessage("web_chat.message_too_long")).toContain("too long");
    expect(friendlyMessage("web_chat.busy")).toContain("still replying");
    expect(friendlyMessage("web_chat.unavailable")).toContain("isn't available");
    expect(friendlyMessage("anything else")).toBe("Something went wrong. Please try again.");
    expect(needsNewConversation("web_chat.limit_reached")).toBe(true);
    expect(needsNewConversation("web_chat.rate_limited")).toBe(false);
  });
});

describe("visitor id", () => {
  it("creates once, then remembers", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const first = getVisitorId(storage);
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(getVisitorId(storage)).toBe(first);
  });

  it("replaces a corrupt saved id", () => {
    const storage = { getItem: () => "bad id!", setItem: () => undefined };
    expect(getVisitorId(storage)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("works when storage throws", () => {
    resetVisitorMemoForTests();
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(getVisitorId(storage)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("sanitizes generated ids", () => {
    expect(newVisitorId(() => "short")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(newVisitorId(() => "123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
  });
});

describe("page config", () => {
  const win = (overrides: { pathname: string; injected?: { apiBase?: string; slug?: string }; meta?: string }) => ({
    __STAGEFLOW_CHAT__: overrides.injected,
    location: { pathname: overrides.pathname },
    document: { querySelector: () => (overrides.meta ? { getAttribute: () => overrides.meta! } : null) },
  });

  it("reads the slug from the path and defaults the API to same-origin", () => {
    expect(readChatConfig(win({ pathname: "/chat/k7x9m2qp4h8d3w6n" }))).toEqual({ slug: "k7x9m2qp4h8d3w6n", apiBase: DEFAULT_API_BASE });
  });

  it("prefers an injected base and slug, then the meta tag, trimming trailing slashes", () => {
    expect(readChatConfig(win({ pathname: "/", injected: { apiBase: "https://host.example/api/public/chat/", slug: "abc" } }))).toEqual({
      slug: "abc",
      apiBase: "https://host.example/api/public/chat",
    });
    expect(readChatConfig(win({ pathname: "/chat/x", meta: "https://other.example/api/public/chat" })).apiBase).toBe("https://other.example/api/public/chat");
  });

  it("has no slug off the chat path", () => {
    expect(readChatConfig(win({ pathname: "/" })).slug).toBeNull();
  });
});

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("chat api", () => {
  it("sends the visitor id and scopes every call to the slug", async () => {
    const fetchImpl = vi.fn(async () => response(200, { threads: [{ id: "t1", title: "Hi", updatedAt: "2026-10-16T00:00:00.000Z" }] }));
    const api = createChatApi({ apiBase: "/api/public/chat", slug: "a b", visitorId: "visitor-visitor-1234", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await api.listThreads()).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/chat/a%20b/threads");
    expect((init.headers as Record<string, string>)["x-visitor-id"]).toBe("visitor-visitor-1234");
  });

  it("turns a JSON error into a ChatApiError with retry-after", async () => {
    const fetchImpl = vi.fn(async () => response(429, { code: "web_chat.rate_limited", message: "x", retryAfterSec: 9 }));
    const api = createChatApi({ apiBase: "/p", slug: "s", visitorId: "visitor-visitor-1234", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.getThread("t1")).rejects.toMatchObject({ code: "web_chat.rate_limited", status: 429, retryAfterSec: 9 });
  });

  it("treats a bare 404 as unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const api = createChatApi({ apiBase: "/p", slug: "s", visitorId: "visitor-visitor-1234", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.info()).rejects.toMatchObject({ code: "web_chat.unavailable" });
  });

  it("streams a reply as frames", async () => {
    const fetchImpl = vi.fn(async () => new Response(streamOf('{"type":"delta","text":"a"}\n'), { status: 200 }));
    const api = createChatApi({ apiBase: "/p", slug: "s", visitorId: "visitor-visitor-1234", fetchImpl: fetchImpl as unknown as typeof fetch });
    const frames: ChatFrame[] = [];
    for await (const frame of api.sendMessage("t1", "hello")) frames.push(frame);
    expect(frames).toEqual([{ type: "delta", text: "a" }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/p/s/threads/t1/messages");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello" });
  });
});

type RunOptions = Parameters<ReturnType<typeof createChatModelAdapter>["run"]>[0];

function runOptions(text: string, signal = new AbortController().signal): RunOptions {
  return { messages: [{ id: "u1", role: "user", content: [{ type: "text", text }] }], abortSignal: signal } as unknown as RunOptions;
}

function fakeApi(frames: ChatFrame[] | (() => AsyncGenerator<ChatFrame>)): ChatApi {
  return {
    sendMessage: typeof frames === "function" ? frames : async function* () { yield* frames; },
  } as unknown as ChatApi;
}

async function drain(run: ReturnType<ReturnType<typeof createChatModelAdapter>["run"]>) {
  const out: Array<Record<string, any>> = [];
  for await (const update of run as AsyncGenerator<Record<string, any>>) out.push(update);
  return out;
}

describe("chat model adapter", () => {
  it("accumulates deltas into cumulative text and completes on done", async () => {
    const adapter = createChatModelAdapter(
      fakeApi([
        { type: "delta", text: "Hel" },
        { type: "delta", text: "lo" },
        { type: "done", message: { id: "m", role: "assistant", text: "Hello", createdAt: "2026-10-16T00:00:00.000Z" } },
      ]),
      async () => "t1",
    );
    const updates = await drain(adapter.run(runOptions("hi")));
    expect(updates.map((u) => u.content[0].text)).toEqual(["Hel", "Hello", "Hello"]);
    expect(updates.at(-1)!.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("marks the message as waiting on the team, then clears it when text resumes", async () => {
    const adapter = createChatModelAdapter(fakeApi([{ type: "waiting" }, { type: "delta", text: "ok" }]), async () => "t1");
    const updates = await drain(adapter.run(runOptions("hi")));
    expect(updates[0]!.metadata.custom.waiting).toBe(true);
    expect(updates[1]!.metadata.custom.waiting).toBe(false);
  });

  it("ends an error frame as an incomplete message with a friendly notice and retry-after", async () => {
    const adapter = createChatModelAdapter(
      fakeApi([{ type: "error", code: "web_chat.rate_limited", message: "internal detail", retryAfterSec: 7 }]),
      async () => "t1",
    );
    const [update] = await drain(adapter.run(runOptions("hi")));
    expect(update!.status).toMatchObject({ type: "incomplete", reason: "error", error: { code: "web_chat.rate_limited", retryAfterSec: 7 } });
    expect(update!.status.error.friendly).not.toContain("internal detail");
    expect(update!.status.error.friendly).toContain("too quickly");
  });

  it("maps a pre-stream API error (limit reached) to the new-conversation notice", async () => {
    const adapter = createChatModelAdapter(
      fakeApi(async function* () {
        throw new ChatApiError("web_chat.limit_reached", 409, "x");
      }),
      async () => "t1",
    );
    const [update] = await drain(adapter.run(runOptions("hi")));
    expect(update!.status.error.friendly).toBe("This conversation has reached its limit. Start a new one.");
  });

  it("stays quiet when the visitor stops the reply", async () => {
    const controller = new AbortController();
    const adapter = createChatModelAdapter(
      fakeApi(async function* () {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
      async () => "t1",
    );
    expect(await drain(adapter.run(runOptions("hi", controller.signal)))).toEqual([]);
  });

  it("fails a stream that ends with nothing", async () => {
    const adapter = createChatModelAdapter(fakeApi([]), async () => "t1");
    const [update] = await drain(adapter.run(runOptions("hi")));
    expect(update!.status.error.code).toBe("web_chat.failed");
  });
});

describe("thread list adapter", () => {
  const api = {
    listThreads: async () => [{ id: "t1", title: "First", updatedAt: "2026-10-16T00:00:00.000Z" }, { id: "t2", title: "", updatedAt: "2026-10-15T00:00:00.000Z" }],
    createThread: async () => ({ id: "t3", title: "", updatedAt: "2026-10-16T00:00:00.000Z" }),
    getThread: async () => ({ thread: { id: "t1", title: "First", updatedAt: "2026-10-16T00:00:00.000Z" }, status: "open", messages: [] }),
  } as unknown as ChatApi;

  it("lists, creates and fetches the visitor's threads", async () => {
    const adapter = createThreadListAdapter(api);
    const { threads } = await adapter.list();
    expect(threads.map((t) => [t.remoteId, t.title, t.status])).toEqual([["t1", "First", "regular"], ["t2", undefined, "regular"]]);
    expect(await adapter.initialize("local")).toEqual({ remoteId: "t3" });
    expect(await adapter.fetch("t1")).toMatchObject({ remoteId: "t1", title: "First" });
  });

  it("titles a conversation from the first message", () => {
    expect(titleFrom("  hello\n   there  ")).toBe("hello there");
    expect(titleFrom("")).toBe("New chat");
    expect(titleFrom("x".repeat(80))).toHaveLength(48);
  });

  it("maps stored messages for history", () => {
    const [user, assistant] = toThreadMessages([
      { id: "a", role: "user", text: "hi", createdAt: "2026-10-16T00:00:00.000Z" },
      { id: "b", role: "assistant", text: "hello", createdAt: "2026-10-16T00:00:01.000Z" },
    ]);
    expect(user).toMatchObject({ id: "a", role: "user", content: [{ type: "text", text: "hi" }] });
    expect(assistant).toMatchObject({ id: "b", role: "assistant", status: { type: "complete" } });
  });
});
