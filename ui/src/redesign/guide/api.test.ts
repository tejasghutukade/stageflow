import { describe, expect, it } from "vitest";
import { readFrames } from "../../chat/ndjson";
import { toGuideFrame, toGuideParts } from "./api";

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
