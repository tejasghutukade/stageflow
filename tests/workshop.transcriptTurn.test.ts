import { describe, expect, it } from "vitest";
import type { WorkshopChatProposalPayload } from "../src/workshop/chatTurn.js";
import {
  appendWorkshopSessionMessages,
  createWorkshopSession,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
} from "../src/workshop/sessionStore.js";
import { transcriptMessagesForTurn } from "../src/workshop/workshopTranscriptTurn.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

function sampleProposal(id: string): WorkshopChatProposalPayload {
  const draft = { pipeline: { id: "demo", stages: [] } };
  return {
    id,
    summary: `Change ${id}`,
    nextDraft: draft,
    baseDraft: draft,
    baseFingerprint: id,
    affectedStageIds: [],
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
      expect(messages[1]).toMatchObject({
        role: "assistant",
        text: "Done.",
        mutations: [
          {
            id: "mut-1",
            summary: "Change mut-1",
            status: "accepted",
            autoApplied: true,
          },
        ],
      });

      appendWorkshopSessionMessages(storeRoot, "sess-mut", messages);
      const loaded = getWorkshopSession(storeRoot, "sess-mut");
      expect(loaded.transcript[1]?.mutations?.[0]?.artifacts[0]?.path).toBe(
        "demo/demo.task.yaml",
      );
    });
  });
});
