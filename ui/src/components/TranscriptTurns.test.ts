import { describe, expect, it } from "vitest";
import type { StageLogEvent } from "../api/types";
import {
  formatActivityDescription,
  formatActivityLabel,
} from "../status/activityCopy";
import {
  buildTranscriptTurns,
  pairToolEvents,
} from "./TranscriptTurns";

describe("pairToolEvents", () => {
  it("nests tool_progress into the open tool without orphan rows", () => {
    const events: StageLogEvent[] = [
      {
        event: "tool_start",
        toolName: "bash",
        toolCallId: "c1",
        argsPreview: '{"command":"ls"}',
      },
      {
        event: "tool_progress",
        toolName: "bash",
        toolCallId: "c1",
        textPreview: "listing…",
      },
      {
        event: "tool_end",
        toolName: "bash",
        toolCallId: "c1",
        resultPreview: "done",
      },
    ];
    expect(pairToolEvents(events)).toEqual([
      {
        name: "bash",
        status: "complete",
        args: '{"command":"ls"}',
        result: "done",
        at: undefined,
      },
    ]);
  });

  it("keeps latest progressPreview while running", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "bash", toolCallId: "c1" },
      {
        event: "tool_progress",
        toolName: "bash",
        toolCallId: "c1",
        textPreview: "first",
      },
      {
        event: "tool_progress",
        toolName: "bash",
        toolCallId: "c1",
        textPreview: "second",
      },
    ];
    expect(pairToolEvents(events)).toEqual([
      {
        name: "bash",
        status: "running",
        args: undefined,
        progressPreview: "second",
        at: undefined,
      },
    ]);
  });

  it("ignores tool_progress without an open tool", () => {
    expect(
      pairToolEvents([
        {
          event: "tool_progress",
          toolName: "bash",
          textPreview: "orphan",
        },
      ]),
    ).toEqual([]);
  });

  it("attaches progress to most recently started open tool without id", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "read", toolCallId: "a" },
      { event: "tool_start", toolName: "bash", toolCallId: "b" },
      {
        event: "tool_progress",
        toolName: "bash",
        textPreview: "out",
      },
    ];
    const calls = pairToolEvents(events);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: "read", status: "running" });
    expect(calls[0].progressPreview).toBeUndefined();
    expect(calls[1]).toMatchObject({
      name: "bash",
      status: "running",
      progressPreview: "out",
    });
  });
});

describe("buildTranscriptTurns", () => {
  it("renders thinking messages as message turns", () => {
    const turns = buildTranscriptTurns([
      { event: "message", role: "thinking", text: "ponder this" },
      { event: "message", role: "assistant", text: "answer" },
    ]);
    expect(turns).toEqual([
      {
        kind: "message",
        event: { event: "message", role: "thinking", text: "ponder this" },
      },
      {
        kind: "message",
        event: { event: "message", role: "assistant", text: "answer" },
      },
    ]);
  });

  it("skips empty thinking text", () => {
    expect(
      buildTranscriptTurns([{ event: "message", role: "thinking", text: "  " }]),
    ).toEqual([]);
  });

  it("batches tool_start/progress/end into one tools turn", () => {
    const turns = buildTranscriptTurns([
      { event: "agent_start" },
      { event: "tool_start", toolName: "bash", toolCallId: "c1" },
      {
        event: "tool_progress",
        toolName: "bash",
        toolCallId: "c1",
        textPreview: "live",
      },
      {
        event: "tool_end",
        toolName: "bash",
        toolCallId: "c1",
        resultPreview: "final",
      },
      { event: "agent_end" },
    ]);
    expect(turns.map((t) => t.kind)).toEqual([
      "system",
      "tools",
      "system",
    ]);
    expect(turns[1]).toMatchObject({
      kind: "tools",
      calls: [
        {
          name: "bash",
          status: "complete",
          result: "final",
        },
      ],
    });
  });

  it("keeps operator prompt and answer turns", () => {
    const turns = buildTranscriptTurns([
      {
        event: "operator_prompt",
        prompt: { kind: "free_text", id: "p1", message: "Ship it?" },
      },
      {
        event: "operator_answer",
        promptId: "p1",
        answer: { kind: "free_text", text: "yes" },
      },
    ]);
    expect(turns.map((t) => t.kind)).toEqual([
      "operator_prompt",
      "operator_answer",
    ]);
  });

  it("does not invent a system turn for orphan tool_progress", () => {
    expect(
      buildTranscriptTurns([
        {
          event: "tool_progress",
          toolName: "bash",
          textPreview: "orphan",
        },
      ]),
    ).toEqual([]);
  });

  it("uses Stage failed once and keeps the reason on the description", () => {
    const event = { event: "failed", reason: "tool error" } as const;
    expect(formatActivityLabel(event)).toBe("Stage failed");
    expect(formatActivityDescription(event)).toBe("tool error");
    expect(buildTranscriptTurns([event])).toEqual([
      { kind: "system", event },
    ]);
  });

  it("omits turn_start when there is no description", () => {
    expect(buildTranscriptTurns([{ event: "turn_start" }])).toEqual([]);
  });

  it("keeps turn_start when a description exists", () => {
    const event = { event: "turn_start", reason: "round 2" };
    expect(formatActivityDescription(event)).toBe("round 2");
    expect(buildTranscriptTurns([event])).toEqual([
      { kind: "system", event },
    ]);
  });
});
