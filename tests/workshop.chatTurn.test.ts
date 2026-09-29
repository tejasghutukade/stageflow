import { describe, expect, it } from "vitest";
import {
  createWorkshopOperatorHost,
  emptyDraftPackage,
} from "../src/operatorAgent/index.js";
import {
  chunkAssistantText,
  iterateWorkshopChatStreamFrames,
  runWorkshopChatTurn,
} from "../src/workshop/chatTurn.js";
import { DEFAULT_WORKSHOP_MODEL } from "../src/workshop/modelSettings.js";

describe("runWorkshopChatTurn", () => {
  it("runs Workshop Author on the fake Operator Agent Host (not AgentPort)", async () => {
    const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
    const draft = emptyDraftPackage("demo");
    const result = await runWorkshopChatTurn({
      draft,
      message: "intake form review",
      host,
      model: "openai/gpt-5",
      settingsDefault: "anthropic/claude-sonnet-4-5",
    });

    expect(result.model).toBe("openai/gpt-5");
    expect(result.pending).not.toBeNull();
    expect(result.pending!.summary).toMatch(/Add stage/i);
    expect(result.pending!.nextDraft.pipeline.stages.length).toBe(1);
    expect(result.draft.pipeline.stages.length).toBe(1);
    expect(result.events.some((e) => e.type === "message")).toBe(true);
    expect(result.events.some((e) => e.type === "proposal")).toBe(true);
  });

  it("respects settings default when session model is absent", async () => {
    const host = createWorkshopOperatorHost([{ type: "echo" }]);
    const result = await runWorkshopChatTurn({
      draft: emptyDraftPackage("demo"),
      message: "hello",
      host,
      settingsDefault: "openai/gpt-5",
    });
    expect(result.model).toBe("openai/gpt-5");
    expect(result.events).toEqual([
      { type: "message", role: "assistant", text: "Got it: hello" },
    ]);
  });

  it("falls back to DEFAULT_WORKSHOP_MODEL", async () => {
    const host = createWorkshopOperatorHost([{ type: "echo" }]);
    const result = await runWorkshopChatTurn({
      draft: emptyDraftPackage("demo"),
      message: "ping",
      host,
    });
    expect(result.model).toBe(DEFAULT_WORKSHOP_MODEL);
  });

  it("applies mutations immediately and returns an undo pending card", async () => {
    const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
    const result = await runWorkshopChatTurn({
      draft: emptyDraftPackage("demo"),
      message: "intake form review",
      host,
    });
    expect(result.autoApply).toBe(false);
    expect(result.draft.pipeline.stages.length).toBe(1);
    expect(result.pending).not.toBeNull();
    expect(result.pending!.nextDraft.pipeline.stages.length).toBe(1);
    expect(result.events.some((e) => e.type === "proposal")).toBe(true);
  });
});

describe("workshop chat stream frames", () => {
  it("chunks assistant text then emits events and done", async () => {
    const host = createWorkshopOperatorHost([{ type: "echo" }]);
    const result = await runWorkshopChatTurn({
      draft: emptyDraftPackage("demo"),
      message: "hello world",
      host,
    });
    const frames = [...iterateWorkshopChatStreamFrames(result)];
    expect(frames.some((f) => f.type === "delta")).toBe(true);
    expect(frames.some((f) => f.type === "event")).toBe(true);
    const done = frames.find((f) => f.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.model).toBe(DEFAULT_WORKSHOP_MODEL);
      expect(done.draft.pipeline.id).toBe("demo");
    }
  });

  it("chunkAssistantText splits deterministically", () => {
    expect(chunkAssistantText("abcdefgh", 3)).toEqual([
      "abc",
      "def",
      "gh",
    ]);
    expect(chunkAssistantText("")).toEqual([]);
  });
});
