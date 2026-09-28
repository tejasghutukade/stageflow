import { describe, expect, it } from "vitest";
import {
  workshopAutosaveSlotKey,
  workshopSessionFingerprint,
  WORKSHOP_UNTITLED_AUTOSAVE_KEY,
} from "./autosave";
import { emptyDraftPackage, type ChatMessage } from "./draft";

describe("workshop autosave helpers", () => {
  it("keys untitled New and pipeline paths", () => {
    expect(workshopAutosaveSlotKey(null)).toBe(WORKSHOP_UNTITLED_AUTOSAVE_KEY);
    expect(workshopAutosaveSlotKey("pipelines/a.pipeline.yaml")).toBe(
      "pipelines/a.pipeline.yaml",
    );
  });

  it("fingerprints session dirty state including auto-apply and model override", () => {
    const draft = emptyDraftPackage("a");
    const messages: ChatMessage[] = [
      { id: "1", role: "assistant", text: "hi" },
    ];
    const a = workshopSessionFingerprint({
      draft,
      messages,
      autoApply: false,
      sessionModelOverride: null,
    });
    const b = workshopSessionFingerprint({
      draft,
      messages,
      autoApply: true,
      sessionModelOverride: null,
    });
    const c = workshopSessionFingerprint({
      draft,
      messages,
      autoApply: false,
      sessionModelOverride: "openai/gpt-5",
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
