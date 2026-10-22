import { describe, expect, it } from "vitest";
import type { EvalDefinition } from "../../../api/evalTypes";
import { initialConversation } from "../newEval/conversationModel";
import { conversationDraftOf, isAgentDefinition, targetSummary, withAgentTarget, withConversationDraft } from "./editModel";

const def = (): EvalDefinition => ({
  version: 1,
  id: "support-eval",
  type: "capability",
  target: { kind: "agent", agent: "support" },
  dataset: "../datasets/support-cases.dataset.jsonl",
  defaults: { repeats: 3, judge: "j/m", user_model: "u/m", pass_threshold: 0.8, max_cost_usd: 1, concurrency: 2 },
  conversation: { mode: "simulated", max_turns: 8, turn_timeout_ms: 120000, tools: "read_only", approvals: "record_only" },
  graders: [{ id: "g", type: "goal_reached" }],
});

describe("editing an agent eval", () => {
  it("recognises agent definitions", () => {
    expect(isAgentDefinition(def())).toBe(true);
    expect(isAgentDefinition({ ...def(), target: { kind: "stage", pipeline: "p", stage: "s" } })).toBe(false);
    expect(isAgentDefinition(null)).toBe(false);
  });

  it("changes the target agent and nothing else", () => {
    expect(withAgentTarget(def(), "triage")).toEqual({ ...def(), target: { kind: "agent", agent: "triage" } });
  });

  it("reads the Conversation card from the definition", () => {
    expect(conversationDraftOf(def())).toMatchObject({ mode: "simulated", maxTurns: 8, turnTimeoutSec: 120, userModel: "u/m", tools: "read_only" });
    expect(conversationDraftOf({ ...def(), conversation: undefined, defaults: undefined })).toEqual(initialConversation());
  });

  it("writes the card back to conversation and defaults.user_model", () => {
    const draft = { ...conversationDraftOf(def()), maxTurns: 12, tools: "mocked" as const, userModel: "other/m" };
    const next = withConversationDraft(def(), draft);
    expect(next.conversation).toEqual({ mode: "simulated", max_turns: 12, turn_timeout_ms: 120000, tools: "mocked", approvals: "record_only" });
    expect(next.defaults?.user_model).toBe("other/m");
    expect(next.defaults).toMatchObject({ repeats: 3, judge: "j/m", pass_threshold: 0.8, max_cost_usd: 1, concurrency: 2 });
  });

  it("removes the user model when the conversation turns to script", () => {
    const next = withConversationDraft(def(), { ...conversationDraftOf(def()), mode: "script" });
    expect(next.defaults).not.toHaveProperty("user_model");
    expect(next.conversation?.mode).toBe("script");
  });

  it("adds the consent only for real tools that were acknowledged", () => {
    const real = { ...conversationDraftOf(def()), tools: "real" as const };
    expect(withConversationDraft(def(), real).conversation).not.toHaveProperty("allow_real_tools");
    expect(withConversationDraft(def(), { ...real, allowReal: true }).conversation).toMatchObject({ tools: "real", allow_real_tools: true });
  });

  it("summarises the target with the live agent", () => {
    expect(targetSummary(def())).toBe("Agent support");
    expect(targetSummary(def(), { name: "Support", revision: 4 })).toBe("Agent Support · r4");
  });
});
