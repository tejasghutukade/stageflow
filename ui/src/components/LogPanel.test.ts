import { describe, expect, it } from "vitest";
import type { StageLogEvent } from "../api/types";
import { buildLogPanelSteps } from "./LogPanel";

describe("buildLogPanelSteps", () => {
  it("turns a completed tool call into one succeeded step", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "bash", toolCallId: "c1", argsPreview: '{"command":"ls"}' },
      { event: "tool_end", toolName: "bash", toolCallId: "c1", resultPreview: "done", at: "2026-01-01T00:00:01.000Z" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "tool",
      label: "bash",
      status: "succeeded",
      detail: "done",
    });
  });

  it("marks a failed tool call as a failed step", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "bash", toolCallId: "c1", isError: true, resultPreview: "exit 1" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "tool", status: "failed", detail: "exit 1" });
  });

  it("marks a not-yet-finished tool call as running", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "bash", toolCallId: "c1" },
      { event: "tool_progress", toolName: "bash", toolCallId: "c1", textPreview: "still going" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "tool", status: "running", detail: "still going" });
  });

  it("expands multiple tool calls in a batch into individual steps, not a single group", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "read", toolCallId: "a" },
      { event: "tool_end", toolName: "read", toolCallId: "a", resultPreview: "ok" },
      { event: "tool_start", toolName: "bash", toolCallId: "b" },
      { event: "tool_end", toolName: "bash", toolCallId: "b", resultPreview: "ok" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps.map((s) => s.kind)).toEqual(["tool", "tool"]);
    expect(steps.map((s) => s.label)).toEqual(["read", "bash"]);
  });

  it("renders a message turn as a succeeded step labeled by role", () => {
    const events: StageLogEvent[] = [
      { event: "message", role: "assistant", text: "here is the answer" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps).toEqual([
      {
        id: "step-0",
        kind: "message",
        label: "assistant",
        status: "succeeded",
        detail: "here is the answer",
        at: undefined,
      },
    ]);
  });

  it("skips empty thinking text, matching the conversational transcript", () => {
    expect(
      buildLogPanelSteps([{ event: "message", role: "thinking", text: "  " }]),
    ).toEqual([]);
  });

  it("renders operator prompt and answer turns with their activity labels", () => {
    const events: StageLogEvent[] = [
      { event: "operator_prompt", prompt: { kind: "free_text", id: "p1", message: "Ship it?" } },
      { event: "operator_answer", promptId: "p1", answer: { kind: "free_text", text: "yes" } },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps.map((s) => s.kind)).toEqual(["operator_prompt", "operator_answer"]);
    expect(steps.map((s) => s.label)).toEqual(["Operator prompt", "Operator answer"]);
    expect(steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("marks the stage-failed lifecycle marker as a failed step carrying the reason", () => {
    const events: StageLogEvent[] = [{ event: "failed", reason: "tool error" }];
    const steps = buildLogPanelSteps(events);
    expect(steps).toEqual([
      {
        id: "step-0",
        kind: "system",
        label: "Stage failed",
        status: "failed",
        detail: "tool error",
        at: undefined,
      },
    ]);
  });

  it("marks other lifecycle markers as succeeded steps", () => {
    const events: StageLogEvent[] = [{ event: "started" }, { event: "agent_start" }];
    const steps = buildLogPanelSteps(events);
    expect(steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
    expect(steps.map((s) => s.label)).toEqual(["Stage started", "Agent started"]);
  });

  it("labels a Read tool call with just the filename, and hides its result content", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Read", toolCallId: "c1", argsPreview: '{"file_path":"/repo/src/index.ts"}' },
      { event: "tool_end", toolName: "Read", toolCallId: "c1", resultPreview: "export function main() {}" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ label: "Read index.ts", status: "succeeded" });
    expect(steps[0].detail).toBeUndefined();
  });

  it("still surfaces the error detail for a failed Read call", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Read", toolCallId: "c1", argsPreview: '{"file_path":"/repo/missing.ts"}' },
      { event: "tool_end", toolName: "Read", toolCallId: "c1", isError: true, resultPreview: "ENOENT: no such file" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({
      label: "Read missing.ts",
      status: "failed",
      detail: "ENOENT: no such file",
    });
  });

  it("labels a Bash tool call with the full command", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", argsPreview: '{"command":"npm test"}' },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", resultPreview: "ok" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({ label: "Bash npm test", detail: "ok" });
  });

  it("labels a Write tool call with just the filename", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Write", toolCallId: "c1", argsPreview: '{"file_path":"/repo/notes.md"}' },
      { event: "tool_end", toolName: "Write", toolCallId: "c1", resultPreview: "wrote 12 lines" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({ label: "Write notes.md" });
  });

  it("falls back to the raw tool name for an unrecognized tool", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "context7_resolve-library-id", toolCallId: "c1", argsPreview: '{"libraryName":"Express"}' },
      { event: "tool_end", toolName: "context7_resolve-library-id", toolCallId: "c1", resultPreview: "found it" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0].label).toBe("context7_resolve-library-id");
  });

  it("falls back to the raw tool name when argsPreview isn't valid JSON", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", argsPreview: "not json" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", resultPreview: "ok" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0].label).toBe("Bash");
  });

  it("falls back to the raw tool name when the expected argument is missing", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", argsPreview: "{}" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", resultPreview: "ok" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0].label).toBe("Bash");
  });

  it("keeps steps in chronological order across mixed event types", () => {
    const events: StageLogEvent[] = [
      { event: "started" },
      { event: "message", role: "user", text: "do the thing" },
      { event: "tool_start", toolName: "bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "bash", toolCallId: "c1", resultPreview: "ok" },
      { event: "message", role: "assistant", text: "done" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps.map((s) => s.kind)).toEqual(["system", "message", "tool", "message"]);
    expect(steps.map((s) => s.id)).toEqual(["step-0", "step-1", "step-2", "step-3"]);
  });
});
