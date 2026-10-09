import { describe, expect, it } from "vitest";
import { CHAT_FAILED_PREFIX, type WorkshopToolActivityRow } from "../../../workshop/workshopChatView";
import { DRAFT_MUTATION_TOOL_NAME } from "../../../workshop/draftMutationTools";
import {
  buildTranscript,
  formatClock,
  userMetaLine,
  workshopSeedMessages,
  type TranscriptAgentTurn,
} from "./transcriptModel";

const tool = (
  id: string,
  textOffset: number,
  status: WorkshopToolActivityRow["status"] = "complete",
): WorkshopToolActivityRow => ({ id, name: "edit_stage", status, textOffset });

describe("buildTranscript", () => {
  it("builds user and agent turns with attachments, times, and mutation cards", () => {
    const at = new Date("2026-10-06T14:16:00");
    const turns = buildTranscript({
      isRunning: false,
      messages: [
        {
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "Add a scan" }],
          createdAt: at,
          metadata: {
            custom: {
              attachments: [{ name: "a.md", size: 3, mediaType: "text/markdown", content: "abc" }],
            },
          },
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: at,
          content: [
            { type: "text", text: "Done." },
            {
              type: "tool-call",
              toolName: DRAFT_MUTATION_TOOL_NAME,
              toolCallId: "tc1",
              args: { mutationId: "m1", summary: "Add scan", affectedStageIds: ["scan"] },
            },
          ],
        },
      ],
    });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: "user",
      text: "Add a scan",
      attachments: [{ name: "a.md", size: 3, mediaType: "text/markdown" }],
    });
    const agent = turns[1] as TranscriptAgentTurn;
    expect(agent.segments).toEqual([{ kind: "text", text: "Done." }]);
    expect(agent.mutations.map((m) => m.args.mutationId)).toEqual(["m1"]);
    expect(agent.streaming).toBe(false);
    expect(agent.createdAt).toEqual(at);
  });

  it("interleaves tool activity only into the current agent turn", () => {
    const turns = buildTranscript({
      isRunning: true,
      toolActivity: [tool("t1", 5), tool("t2", 5, "running")],
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "two" },
        { role: "assistant", content: "Plan.Then." },
      ],
    });
    const earlier = turns[1] as TranscriptAgentTurn;
    expect(earlier.segments).toEqual([{ kind: "text", text: "First reply" }]);
    const current = turns[3] as TranscriptAgentTurn;
    expect(current.segments.map((segment) => segment.kind)).toEqual(["text", "tools", "text"]);
    expect(current.streaming).toBe(true);
    expect(current.working).toBe(false);
  });

  it("shows a working placeholder while the first delta is pending", () => {
    const placeholder = buildTranscript({
      isRunning: true,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "…" },
      ],
    });
    expect(placeholder[1]).toMatchObject({ kind: "agent", segments: [], working: true });

    const noAssistant = buildTranscript({
      isRunning: true,
      toolActivity: [tool("t1", 0, "running")],
      messages: [{ role: "user", content: "go" }],
    });
    expect(noAssistant[1]).toMatchObject({
      kind: "agent",
      key: "pending-agent",
      working: false,
      segments: [{ kind: "tools" }],
    });
  });

  it("flags failures and keeps system notes", () => {
    const turns = buildTranscript({
      isRunning: false,
      messages: [
        { role: "system", content: "Session restored" },
        { role: "user", content: "go" },
        { role: "assistant", content: `${CHAT_FAILED_PREFIX} boom` },
      ],
    });
    expect(turns[0]).toEqual({ kind: "system", key: "m-0", text: "Session restored" });
    expect((turns[2] as TranscriptAgentTurn).failed).toBe(true);
  });
});

describe("time and seeds", () => {
  it("formats the you meta line and omits time when unknown", () => {
    expect(formatClock(new Date("2026-10-06T14:16:00"))).toBe("2:16 PM");
    expect(userMetaLine(null)).toBe("you");
    expect(userMetaLine(new Date("2026-10-06T09:05:00"))).toBe("you · 9:05 AM");
  });

  it("maps stored session messages to seeds with createdAt and attachment chips", () => {
    const seeds = workshopSeedMessages([
      {
        role: "user",
        text: "hi",
        createdAt: "2026-10-06T14:16:00.000Z",
        attachments: [{ name: "notes.md", size: 12, mediaType: "text/markdown" }],
      },
      { role: "tool", text: "x" },
      { role: "assistant", text: "yo", createdAt: "not a date" },
    ]);
    expect(seeds[0]).toMatchObject({
      role: "user",
      content: "hi",
      metadata: { custom: { attachments: [{ name: "notes.md", size: 12, mediaType: "text/markdown" }] } },
    });
    expect(seeds[0]!.createdAt).toBeInstanceOf(Date);
    expect(seeds[1]!.role).toBe("assistant");
    expect(seeds[2]!.createdAt).toBeUndefined();
  });
});
