import { describe, expect, it } from "vitest";
import type { WorkshopChatProposalPayload } from "../src/workshop/chatTurn.js";
import {
  appendWorkshopSessionMessages,
  createWorkshopSession,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
} from "../src/workshop/sessionStore.js";
import { parseWorkshopSessionMutationSnapshot } from "../src/workshop/sessionMutations.js";
import { transcriptMessagesForTurn } from "../src/workshop/workshopTranscriptTurn.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

function sampleProposal(id: string): WorkshopChatProposalPayload {
  return {
    id,
    summary: `Change ${id}`,
    baseDraft: {
      pipeline: { id: "demo", stages: [{ id: "scan" }] },
    },
    nextDraft: {
      pipeline: {
        id: "demo",
        stages: [{ id: "scan" }, { id: "review", prompt: "check" }],
      },
      task: { filename: "demo.task.yaml", body: { id: "demo" } },
    },
    baseFingerprint: `fp-${id}`,
    affectedStageIds: ["review"],
    artifacts: [
      {
        path: "demo/demo.task.yaml",
        kind: "added",
        after: "task: demo",
      },
    ],
  };
}

describe("workshop transcript turn", () => {
  it("persists assistant text and mutation snapshots on the assistant row", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-mut" });

      const messages = transcriptMessagesForTurn(
        "add a task",
        [],
        [
          { type: "message", role: "assistant", text: "Done." },
          { type: "proposal", proposal: sampleProposal("mut-1") },
        ],
        { autoApply: true },
      );

      expect(messages).toHaveLength(2);
      const proposal = sampleProposal("mut-1");
      expect(messages[1]).toMatchObject({
        role: "assistant",
        text: "Done.",
        mutations: [
          {
            id: "mut-1",
            summary: "Change mut-1",
            status: "accepted",
            autoApplied: true,
            baseDraft: proposal.baseDraft,
            nextDraft: proposal.nextDraft,
            baseFingerprint: "fp-mut-1",
          },
        ],
      });

      appendWorkshopSessionMessages(storeRoot, "sess-mut", messages);
      const loaded = getWorkshopSession(storeRoot, "sess-mut");
      const mutation = loaded.transcript[1]?.mutations?.[0];
      expect(mutation?.artifacts[0]?.path).toBe("demo/demo.task.yaml");
      expect(mutation?.baseDraft).toEqual(proposal.baseDraft);
      expect(mutation?.nextDraft).toEqual(proposal.nextDraft);
      expect(mutation?.baseFingerprint).toBe("fp-mut-1");
    });
  });

  it("loads legacy mutation snapshots that have no drafts", () => {
    const parsed = parseWorkshopSessionMutationSnapshot({
      id: "mut-old",
      summary: "legacy",
      affectedStageIds: ["scan"],
      artifacts: [{ path: "scan.stage.yaml", kind: "added" }],
      status: "accepted",
    });
    expect(parsed).toEqual({
      id: "mut-old",
      summary: "legacy",
      affectedStageIds: ["scan"],
      artifacts: [{ path: "scan.stage.yaml", kind: "added" }],
      status: "accepted",
    });
  });

  it("keeps a snapshot when stored drafts are malformed", () => {
    const parsed = parseWorkshopSessionMutationSnapshot({
      id: "mut-bad",
      summary: "bad draft",
      affectedStageIds: [],
      artifacts: [],
      status: "rejected",
      baseDraft: "nope",
      nextDraft: { pipeline: { id: 1 } },
    });
    expect(parsed).toEqual({
      id: "mut-bad",
      summary: "bad draft",
      affectedStageIds: [],
      artifacts: [],
      status: "rejected",
    });
  });
});
