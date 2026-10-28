import { describe, expect, it, vi } from "vitest";
import { readFrames } from "../../chat/ndjson";
import { createGuideApi, guideThreadStatus, toGuideFrame, toGuideParts } from "./api";

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("toGuideFrame", () => {
  it("reads running and finished tool frames", () => {
    expect(toGuideFrame({ type: "tool", id: "t1", name: "create_pipeline", status: "running", args: { id: "ship" } })).toEqual({
      type: "tool",
      id: "t1",
      name: "create_pipeline",
      status: "running",
      args: { id: "ship" },
    });
    expect(toGuideFrame({ type: "tool", id: "t1", name: "create_pipeline", status: "complete", result: { ok: true } })).toEqual({
      type: "tool",
      id: "t1",
      name: "create_pipeline",
      status: "complete",
      result: { ok: true },
    });
    expect(toGuideFrame({ type: "tool", id: "t1", name: "x", status: "error", error: "Nope" })).toEqual({
      type: "tool",
      id: "t1",
      name: "x",
      status: "error",
      error: "Nope",
    });
  });

  it("drops malformed tool frames", () => {
    expect(toGuideFrame({ type: "tool", name: "x", status: "running" })).toBeNull();
    expect(toGuideFrame({ type: "tool", id: "t1", name: "x", status: "queued" })).toBeNull();
    expect(toGuideFrame({ type: "tool", id: "t1", status: "running" })).toBeNull();
  });

  it("keeps the ordered parts of a done message", () => {
    const frame = toGuideFrame({
      type: "done",
      message: {
        id: "m1",
        role: "assistant",
        text: "Hi",
        createdAt: "2026-10-24T00:00:00.000Z",
        parts: [{ type: "tool", id: "t1", name: "show_ui", status: "complete", result: { ui: {} } }, { type: "text", text: "Hi" }, { type: "bogus" }],
      },
    });
    expect(frame).toEqual({
      type: "done",
      message: {
        id: "m1",
        role: "assistant",
        text: "Hi",
        createdAt: "2026-10-24T00:00:00.000Z",
        parts: [{ type: "tool", id: "t1", name: "show_ui", status: "complete", result: { ui: {} } }, { type: "text", text: "Hi" }],
      },
    });
  });

  it("still reads the existing chat frames", () => {
    expect(toGuideFrame({ type: "delta", text: "a" })).toEqual({ type: "delta", text: "a" });
    expect(toGuideFrame({ type: "error", code: "x", message: "y" })).toEqual({ type: "error", code: "x", message: "y" });
    expect(toGuideFrame({ type: "done", message: { id: "m", text: "t", createdAt: "c" } })).toEqual({
      type: "done",
      message: { id: "m", role: "assistant", text: "t", createdAt: "c" },
    });
  });
});

describe("toGuideParts", () => {
  it("returns undefined when there is nothing usable", () => {
    expect(toGuideParts(undefined)).toBeUndefined();
    expect(toGuideParts([])).toBeUndefined();
    expect(toGuideParts([{ type: "tool", id: "t", name: "x", status: "running" }])).toBeUndefined();
  });
});

describe("readFrames with the Guide decoder", () => {
  it("yields tool frames between deltas", async () => {
    const body = stream(
      [
        JSON.stringify({ type: "delta", text: "Let me " }),
        JSON.stringify({ type: "tool", id: "t1", name: "list_pipelines", status: "running" }),
        JSON.stringify({ type: "tool", id: "t1", name: "list_pipelines", status: "complete", result: [] }),
        JSON.stringify({ type: "unknown" }),
      ].join("\n"),
    );
    const frames = [];
    for await (const frame of readFrames(body, toGuideFrame)) frames.push(frame);
    expect(frames.map((frame) => frame.type)).toEqual(["delta", "tool", "tool"]);
  });
});

describe("guideThreadStatus", () => {
  it("keeps running and defaults everything else to open", () => {
    expect(guideThreadStatus("running")).toBe("running");
    expect(guideThreadStatus("open")).toBe("open");
    expect(guideThreadStatus("waiting")).toBe("open");
    expect(guideThreadStatus(undefined)).toBe("open");
  });
});

describe("createGuideApi thread status and stop", () => {
  it("maps list and get status and posts stop", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/guide/threads") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            threads: [
              { id: "a", title: "A", updatedAt: "2026-10-28T00:00:00.000Z", status: "running" },
              { id: "b", title: "B", updatedAt: "2026-10-27T00:00:00.000Z" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/guide/threads/a") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            thread: { id: "a", title: "A", updatedAt: "2026-10-28T00:00:00.000Z" },
            status: "running",
            messages: [],
            model: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/guide/threads/a/stop") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, stopped: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    const api = createGuideApi(fetchImpl as unknown as typeof fetch);
    await expect(api.listThreads()).resolves.toEqual([
      { id: "a", title: "A", updatedAt: "2026-10-28T00:00:00.000Z", status: "running" },
      { id: "b", title: "B", updatedAt: "2026-10-27T00:00:00.000Z", status: "open" },
    ]);
    await expect(api.getThread("a")).resolves.toMatchObject({ status: "running", model: null });
    await expect(api.stopTurn("a")).resolves.toEqual({ ok: true, stopped: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/guide/threads/a/stop",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });
});
