import { describe, expect, it } from "vitest";
import type { WorkshopChatTurnPayload } from "../api/types";
import {
  applyWorkshopChatTurn,
  assistantMessageFromDeltas,
  toWorkshopProposal,
} from "./chatClient";
import { emptyDraftPackage } from "./draft";

const sampleProposal = {
  id: "proposal-1",
  summary: "Add stage “intake”",
  nextDraft: {
    pipeline: {
      id: "demo",
      stages: [{ id: "intake", uses: "./intake.yaml", entry: true }],
    },
    stages: [
      {
        path: "./intake.yaml",
        body: { id: "intake", system_prompt: "x", model: "m" },
      },
    ],
  },
  baseDraft: emptyDraftPackage("demo"),
  baseFingerprint: "{}",
  artifacts: [
    {
      path: "demo.pipeline.yaml",
      kind: "modified" as const,
      before: "[]",
      after: "[intake]",
    },
  ],
  affectedStageIds: ["intake"],
};

describe("applyWorkshopChatTurn", () => {
  it("attaches pending proposal to the assistant message for tool cards", () => {
    let n = 0;
    const turn: WorkshopChatTurnPayload = {
      events: [
        {
          type: "message",
          role: "assistant",
          text: "I propose: Add stage “intake”.",
        },
        { type: "proposal", proposal: sampleProposal, autoApplied: false },
      ],
      draft: emptyDraftPackage("demo"),
      pending: sampleProposal,
      autoApply: false,
      model: "anthropic/claude-sonnet-4-5",
    };

    const applied = applyWorkshopChatTurn({
      turn,
      nextMessageId: () => `m-${++n}`,
    });

    expect(applied.pending?.id).toBe("proposal-1");
    expect(applied.messages).toHaveLength(1);
    expect(applied.messages[0]).toMatchObject({
      role: "assistant",
      proposalId: "proposal-1",
      proposalSummary: "Add stage “intake”",
    });
    expect(applied.messages[0]!.artifacts?.length).toBe(1);
    expect(toWorkshopProposal(sampleProposal).nextDraft.pipeline.stages).toHaveLength(
      1,
    );
  });

  it("applies auto-applied proposals to draft without pending card", () => {
    let n = 0;
    const turn: WorkshopChatTurnPayload = {
      events: [
        {
          type: "message",
          role: "assistant",
          text: "Applied to draft: Add stage “intake”.",
        },
        { type: "proposal", proposal: sampleProposal, autoApplied: true },
      ],
      draft: sampleProposal.nextDraft,
      pending: null,
      autoApply: true,
      model: "openai/gpt-5",
    };

    const applied = applyWorkshopChatTurn({
      turn,
      nextMessageId: () => `m-${++n}`,
    });

    expect(applied.pending).toBeNull();
    expect(applied.autoApply).toBe(true);
    expect(applied.draft.pipeline.stages).toHaveLength(1);
    expect(applied.messages[0]?.proposalId).toBeUndefined();
    expect(applied.messages[0]?.artifacts?.length).toBe(1);
  });

  it("maps system auto-apply status messages", () => {
    let n = 0;
    const applied = applyWorkshopChatTurn({
      turn: {
        events: [
          {
            type: "message",
            role: "system",
            text: "Auto-apply chat edits is on.",
          },
        ],
        draft: emptyDraftPackage("demo"),
        pending: null,
        autoApply: true,
        model: "anthropic/claude-sonnet-4-5",
      },
      nextMessageId: () => `m-${++n}`,
    });
    expect(applied.messages[0]?.role).toBe("system");
    expect(applied.autoApply).toBe(true);
  });
});

describe("assistantMessageFromDeltas", () => {
  it("joins streamed chunks", () => {
    expect(assistantMessageFromDeltas(["Hel", "lo"], "a1").text).toBe("Hello");
  });
});
