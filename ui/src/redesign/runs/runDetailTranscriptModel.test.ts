import { describe, expect, it } from "vitest";
import type { StageLogEvent } from "../../api/types";
import {
  buildRunDetailTranscriptTurns,
  isRunDetailTranscriptNoiseEvent,
  stageAgentLabel,
} from "./runDetailTranscriptModel";

describe("isRunDetailTranscriptNoiseEvent", () => {
  it("treats fork-demo lifecycle markers as noise", () => {
    const noise: StageLogEvent[] = [
      { event: "started", at: "2026-01-01T09:00:00.000Z" },
      { event: "agent_start" },
      { event: "waiting_for_input", at: "2026-01-01T09:05:00.000Z" },
      {
        event: "operator_prompt",
        prompt: { kind: "free_text", id: "p1", message: "branch-a or branch-b?" },
      },
      { event: "turn_start" },
      { event: "agent_end" },
      { event: "succeeded" },
    ];
    for (const event of noise) {
      expect(isRunDetailTranscriptNoiseEvent(event)).toBe(true);
    }
  });

  it("keeps turn_start when a description exists", () => {
    expect(
      isRunDetailTranscriptNoiseEvent({
        event: "turn_start",
        reason: "round 2",
      }),
    ).toBe(false);
  });

  it("does not treat messages or answers as noise", () => {
    expect(
      isRunDetailTranscriptNoiseEvent({
        event: "message",
        role: "assistant",
        text: "hello",
      }),
    ).toBe(false);
    expect(
      isRunDetailTranscriptNoiseEvent({
        event: "operator_answer",
        answer: { kind: "free_text", text: "branch-b" },
      }),
    ).toBe(false);
  });
});

describe("buildRunDetailTranscriptTurns", () => {
  it("drops prompts and lifecycle noise from fork-demo style logs", () => {
    const events: StageLogEvent[] = [
      { event: "started" },
      { event: "agent_start" },
      { event: "message", role: "opening", text: "Reading the decide gate brief." },
      { event: "tool_start", toolName: "read", toolCallId: "c1" },
      { event: "tool_end", toolName: "read", toolCallId: "c1", resultPreview: "ok" },
      { event: "message", role: "assistant", text: "Which branch?" },
      {
        event: "operator_prompt",
        prompt: { kind: "free_text", id: "p1", message: "branch-a or branch-b?" },
      },
      { event: "waiting_for_input" },
      {
        event: "operator_answer",
        answer: { kind: "free_text", text: "branch-b" },
      },
      { event: "agent_end" },
      { event: "succeeded" },
    ];
    expect(buildRunDetailTranscriptTurns(events).map((t) => t.kind)).toEqual([
      "message",
      "tools",
      "message",
      "operator_answer",
    ]);
  });

  it("does not invent turns for orphan tool_progress", () => {
    expect(
      buildRunDetailTranscriptTurns([
        {
          event: "tool_progress",
          toolName: "bash",
          textPreview: "orphan",
        },
      ]),
    ).toEqual([]);
  });

  it("optionally merges consecutive assistant messages", () => {
    const events: StageLogEvent[] = [
      { event: "message", role: "assistant", text: "part one" },
      { event: "message", role: "assistant", text: "part two" },
    ];
    expect(
      buildRunDetailTranscriptTurns(events, { mergeConsecutiveAssistant: true }),
    ).toEqual([
      {
        kind: "message",
        event: {
          event: "message",
          role: "assistant",
          text: "part one\n\npart two",
        },
      },
    ]);
  });
});

describe("stageAgentLabel", () => {
  it("lowercases stage label and appends agent once", () => {
    expect(stageAgentLabel("Decide")).toBe("decide agent");
    expect(stageAgentLabel("review agent")).toBe("review agent");
  });
});
