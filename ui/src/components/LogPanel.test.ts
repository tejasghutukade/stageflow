import { describe, expect, it } from "vitest";
import type { StageLogEvent } from "../api/types";
import {
  buildLogPanelSteps,
  failureBannerText,
  findFailingStepId,
  formatDuration,
  stepDurationMs,
} from "./LogPanel";

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
      label: "bash ls",
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
        defaultExpanded: false,
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
        defaultExpanded: true,
        sourceEvent: "failed",
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

  it("still recovers the filename when argsPreview is truncated (invalid) JSON", () => {
    // Mirrors how the backend actually produces argsPreview: JSON.stringify(input)
    // cut off at a fixed character limit with a trailing ellipsis, regardless of
    // where that lands — here mid-way through a long old_string value.
    const truncated = `{"file_path":"/repo/big.ts","old_string":"line one\\nline two\\nline th…`;
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Edit", toolCallId: "c1", argsPreview: truncated },
      { event: "tool_end", toolName: "Edit", toolCallId: "c1", resultPreview: "ok" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0].label).toBe("Edit big.ts");
  });

  it("falls back to the raw tool name when the expected argument is missing", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", argsPreview: "{}" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", resultPreview: "ok" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0].label).toBe("Bash");
  });

  it("labels the Pi backend's lowercase tool names the same way as Claude's capitalized ones", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "read", toolCallId: "c1", argsPreview: '{"file_path":"/repo/src/index.ts"}' },
      { event: "tool_end", toolName: "read", toolCallId: "c1", resultPreview: "export function main() {}" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({ label: "read index.ts", status: "succeeded" });
    expect(steps[0].detail).toBeUndefined();
  });

  it("carries the paired start and end timestamps on a completed tool step", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", at: "2026-01-01T00:00:00.000Z" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", resultPreview: "ok", at: "2026-01-01T00:00:05.000Z" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z",
    });
  });

  it("leaves finishedAt unset on a still-running tool step", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", at: "2026-01-01T00:00:00.000Z" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({ startedAt: "2026-01-01T00:00:00.000Z", finishedAt: undefined });
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

describe("default expand/collapse", () => {
  it("defaults the running step to expanded and finished non-failed steps to collapsed", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Read", toolCallId: "c1", argsPreview: '{"file_path":"a.ts"}' },
      { event: "tool_end", toolName: "Read", toolCallId: "c1", resultPreview: "ok" },
      { event: "tool_start", toolName: "Bash", toolCallId: "c2" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({ status: "succeeded", defaultExpanded: false });
    expect(steps[1]).toMatchObject({ status: "running", defaultExpanded: true });
  });

  it("defaults the failing tool step to expanded when there is no terminal failed marker yet", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", isError: true, resultPreview: "boom" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({ status: "failed", defaultExpanded: true });
  });

  it("prefers the terminal Stage failed marker over the tool call that caused it", () => {
    const events: StageLogEvent[] = [
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", isError: true, resultPreview: "boom" },
      { event: "failed", reason: "boom" },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps[0]).toMatchObject({ kind: "tool", status: "failed", defaultExpanded: false });
    expect(steps[1]).toMatchObject({ kind: "system", status: "failed", defaultExpanded: true });
  });
});

describe("findFailingStepId", () => {
  it("returns undefined when nothing failed", () => {
    const steps = buildLogPanelSteps([{ event: "started" }]);
    expect(findFailingStepId(steps)).toBeUndefined();
  });

  it("picks the terminal system failure over an earlier tool failure", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", isError: true },
      { event: "failed", reason: "boom" },
    ]);
    expect(findFailingStepId(steps)).toBe(steps[1].id);
  });

  it("falls back to the failing tool call when there is no terminal system failure", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", isError: true },
    ]);
    expect(findFailingStepId(steps)).toBe(steps[0].id);
  });

  it("stops flagging an earlier tool error once the stage has actually succeeded", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", isError: true, resultPreview: "flaky, retried" },
      { event: "tool_start", toolName: "Bash", toolCallId: "c2" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c2", resultPreview: "ok" },
      { event: "succeeded" },
    ]);
    expect(findFailingStepId(steps)).toBeUndefined();
    expect(steps[0]).toMatchObject({ status: "failed", defaultExpanded: false });
  });
});

describe("failureBannerText", () => {
  it("is undefined when the stage has not failed", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", resultPreview: "ok" },
    ]);
    expect(failureBannerText(steps, findFailingStepId(steps))).toBeUndefined();
  });

  it("is undefined for a tool error that hasn't (yet) failed the stage", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", isError: true, resultPreview: "boom" },
    ]);
    expect(failureBannerText(steps, findFailingStepId(steps))).toBeUndefined();
  });

  it("returns the failure reason once the stage has a terminal failed marker", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", isError: true, resultPreview: "boom" },
      { event: "failed", reason: "3 tests failed after npm test" },
    ]);
    expect(failureBannerText(steps, findFailingStepId(steps))).toBe("3 tests failed after npm test");
  });

  it("falls back to the step label when the failed marker carries no reason", () => {
    const steps = buildLogPanelSteps([{ event: "failed" }]);
    expect(failureBannerText(steps, findFailingStepId(steps))).toBe("Stage failed");
  });
});

describe("formatDuration", () => {
  it("shows sub-second durations as <1s", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("shows whole seconds under a minute", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(23000)).toBe("23s");
  });

  it("shows minutes and seconds at or over a minute", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(600000)).toBe("10m 0s");
  });
});

describe("stepDurationMs", () => {
  const now = Date.parse("2026-01-01T00:01:00.000Z");

  it("computes elapsed time for a completed tool step", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", at: "2026-01-01T00:00:00.000Z" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", at: "2026-01-01T00:00:05.000Z" },
    ]);
    expect(stepDurationMs(steps[0], now)).toBe(5000);
  });

  it("computes live elapsed time for a running tool step using the supplied now", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1", at: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(stepDurationMs(steps[0], now)).toBe(60000);
  });

  it("returns undefined for non-tool steps", () => {
    const steps = buildLogPanelSteps([
      { event: "message", role: "assistant", text: "hi", at: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(stepDurationMs(steps[0], now)).toBeUndefined();
  });

  it("returns undefined when there is no start timestamp to anchor from", () => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName: "Bash", toolCallId: "c1" },
      { event: "tool_end", toolName: "Bash", toolCallId: "c1", at: "2026-01-01T00:00:05.000Z" },
    ]);
    expect(stepDurationMs(steps[0], now)).toBeUndefined();
  });
});
