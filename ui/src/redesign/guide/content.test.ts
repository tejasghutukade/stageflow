import { describe, expect, it } from "vitest";
import type { GuideToolFrame } from "./api";
import { applyGuideFrame, finalGuideContent, guidePartsToContent, type GuideContentPart } from "./content";

function run(frames: Array<{ type: "delta"; text: string } | GuideToolFrame>): GuideContentPart[] {
  return frames.reduce<GuideContentPart[]>((content, frame) => applyGuideFrame(content, frame), []);
}

describe("applyGuideFrame", () => {
  it("joins deltas into one text part", () => {
    expect(run([{ type: "delta", text: "Hel" }, { type: "delta", text: "lo" }])).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("keeps text and tool calls in arrival order", () => {
    const content = run([
      { type: "delta", text: "Making it. " },
      { type: "tool", id: "t1", name: "create_pipeline", status: "running", args: { id: "ship" } },
      { type: "delta", text: "Done." },
    ]);
    expect(content).toEqual([
      { type: "text", text: "Making it. " },
      { type: "tool-call", toolCallId: "t1", toolName: "create_pipeline", args: { id: "ship" }, argsText: '{"id":"ship"}' },
      { type: "text", text: "Done." },
    ]);
  });

  it("updates a running call in place when it completes, keeping its args", () => {
    const content = run([
      { type: "tool", id: "t1", name: "create_pipeline", status: "running", args: { id: "ship" } },
      { type: "delta", text: "after" },
      { type: "tool", id: "t1", name: "create_pipeline", status: "complete", result: { path: "ship.pipeline.yaml" } },
    ]);
    expect(content).toEqual([
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "create_pipeline",
        args: { id: "ship" },
        argsText: '{"id":"ship"}',
        result: { path: "ship.pipeline.yaml" },
      },
      { type: "text", text: "after" },
    ]);
  });

  it("marks an errored call with the error as its result", () => {
    const content = run([
      { type: "tool", id: "t1", name: "validate", status: "running" },
      { type: "tool", id: "t1", name: "validate", status: "error", error: "Pipeline not found" },
    ]);
    expect(content).toEqual([
      { type: "tool-call", toolCallId: "t1", toolName: "validate", args: {}, argsText: "{}", isError: true, result: "Pipeline not found" },
    ]);
  });

  it("gives a completed call without a result a null result so it reads as settled", () => {
    const content = run([{ type: "tool", id: "t1", name: "x", status: "complete" }]);
    expect(content[0]).toMatchObject({ type: "tool-call", result: null });
  });

  it("does not mutate the content it is given", () => {
    const before: GuideContentPart[] = [{ type: "text", text: "a" }];
    applyGuideFrame(before, { type: "delta", text: "b" });
    expect(before).toEqual([{ type: "text", text: "a" }]);
  });
});

describe("guidePartsToContent", () => {
  it("converts stored parts the same way as streamed frames", () => {
    expect(
      guidePartsToContent([
        { type: "text", text: "Here it is" },
        { type: "tool", id: "t1", name: "show_ui", status: "complete", args: { a: 1 }, result: { ui: { component: "plan" } } },
        { type: "tool", id: "t2", name: "edit_stage", status: "error", error: "Locked" },
      ]),
    ).toEqual([
      { type: "text", text: "Here it is" },
      { type: "tool-call", toolCallId: "t1", toolName: "show_ui", args: { a: 1 }, argsText: '{"a":1}', result: { ui: { component: "plan" } } },
      { type: "tool-call", toolCallId: "t2", toolName: "edit_stage", args: {}, argsText: "{}", isError: true, result: "Locked" },
    ]);
  });
});

describe("finalGuideContent", () => {
  const message = { id: "m", role: "assistant" as const, text: "Final text", createdAt: "c" };

  it("prefers the stored parts", () => {
    expect(finalGuideContent({ ...message, parts: [{ type: "text", text: "From parts" }] }, [{ type: "text", text: "streamed" }])).toEqual([
      { type: "text", text: "From parts" },
    ]);
  });

  it("keeps streamed tool calls when the message has no parts", () => {
    const streamed = run([{ type: "tool", id: "t1", name: "x", status: "complete", result: 1 }, { type: "delta", text: "ok" }]);
    expect(finalGuideContent(message, streamed)).toEqual(streamed);
  });

  it("falls back to the message text", () => {
    expect(finalGuideContent(message, [{ type: "text", text: "Final te" }])).toEqual([{ type: "text", text: "Final text" }]);
    expect(finalGuideContent(message, [])).toEqual([{ type: "text", text: "Final text" }]);
  });
});
