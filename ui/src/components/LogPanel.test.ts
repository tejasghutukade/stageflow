import { describe, expect, it } from "vitest";
import type { StageLogEvent } from "../api/types";
import {
  buildLogPanelSteps,
  failureBannerText,
  findFailingStepId,
  formatDuration,
  stepDurationMs,
  stepPreview,
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

  it("labels a feedback loop decision as a system step with the reason", () => {
    const events: StageLogEvent[] = [
      {
        event: "feedback_loop_decided",
        decision: "continue",
        loopId: "loop-1",
        reason: "ship the brief",
      },
    ];
    const steps = buildLogPanelSteps(events);
    expect(steps).toEqual([
      {
        id: "step-0",
        kind: "system",
        label: "Feedback loop decided",
        status: "succeeded",
        detail: "continue — ship the brief",
        at: undefined,
        defaultExpanded: false,
        sourceEvent: "feedback_loop_decided",
      },
    ]);
  });

  it("describes a feedback loop decision without a reason as decision-only", () => {
    const steps = buildLogPanelSteps([
      { event: "feedback_loop_decided", decision: "extend", loopId: "loop-1" },
    ]);
    expect(steps[0]).toMatchObject({
      kind: "system",
      label: "Feedback loop decided",
      status: "succeeded",
      detail: "extend",
    });
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

  it.each([
    {
      name: "Read: filename only, result content hidden",
      toolName: "Read",
      args: '{"file_path":"/repo/src/index.ts"}',
      result: "export function main() {}",
      label: "Read index.ts",
      detail: undefined,
    },
    {
      name: "lowercase Pi tool name labelled like Claude's capitalized one",
      toolName: "read",
      args: '{"file_path":"/repo/src/index.ts"}',
      result: "export function main() {}",
      label: "read index.ts",
      detail: undefined,
    },
    {
      name: "Bash: full command",
      toolName: "Bash",
      args: '{"command":"npm test"}',
      result: "ok",
      label: "Bash npm test",
      detail: "ok",
    },
    {
      name: "Write: filename only",
      toolName: "Write",
      args: '{"file_path":"/repo/notes.md"}',
      result: "wrote 12 lines",
      label: "Write notes.md",
      detail: "wrote 12 lines",
    },
    {
      name: "unrecognized tool falls back to the raw name",
      toolName: "context7_resolve-library-id",
      args: '{"libraryName":"Express"}',
      result: "found it",
      label: "context7_resolve-library-id",
      detail: "found it",
    },
    {
      name: "invalid JSON args fall back to the raw name",
      toolName: "Bash",
      args: "not json",
      result: "ok",
      label: "Bash",
      detail: "ok",
    },
    {
      // Mirrors the backend: JSON.stringify(input) cut at a fixed limit with a trailing ellipsis.
      name: "truncated JSON args still recover the filename",
      toolName: "Edit",
      args: `{"file_path":"/repo/big.ts","old_string":"line one\\nline two\\nline th…`,
      result: "ok",
      label: "Edit big.ts",
      detail: "ok",
    },
    {
      name: "missing expected argument falls back to the raw name",
      toolName: "Bash",
      args: "{}",
      result: "ok",
      label: "Bash",
      detail: "ok",
    },
  ])("tool label: $name", ({ toolName, args, result, label, detail }) => {
    const steps = buildLogPanelSteps([
      { event: "tool_start", toolName, toolCallId: "c1", argsPreview: args },
      { event: "tool_end", toolName, toolCallId: "c1", resultPreview: result },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ label, status: "succeeded" });
    expect(steps[0].detail).toBe(detail);
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

describe("stepPreview", () => {
  it("shows the whole string as the preview with no expand affordance when it's short and single-line", () => {
    expect(stepPreview("single line")).toEqual({ preview: "single line", hasMore: false, rest: "" });
  });

  it("continues from the second line onward without repeating the preview", () => {
    expect(stepPreview("Error: 3 tests failed\n  at runTests (test.js:12)")).toEqual({
      preview: "Error: 3 tests failed",
      hasMore: true,
      rest: "  at runTests (test.js:12)",
    });
  });

  it("truncates the preview and continues from the cutoff (not a line) when there's no space to back up to", () => {
    // Tool results are frequently one long JSON-stringified blob with no real
    // newlines at all — length alone has to be able to trigger "there's more",
    // and the expanded view has to pick up exactly where the preview stopped.
    // With no space anywhere to back up to, a hard cutoff is unavoidable.
    const longSingleLine = `${"x".repeat(160)}${"y".repeat(140)}`;
    expect(stepPreview(longSingleLine)).toEqual({
      preview: `${"x".repeat(160)}…`,
      hasMore: true,
      rest: "y".repeat(140),
    });
  });

  it("backs up to the last full word instead of splitting one across the cutoff", () => {
    const longSingleLine = `${"x".repeat(150)} ${"y".repeat(50)}`;
    expect(stepPreview(longSingleLine)).toEqual({
      preview: `${"x".repeat(150)}…`,
      hasMore: true,
      rest: "y".repeat(50),
    });
  });

  it("strips a blank line right after the first line so expanding doesn't show an empty gap", () => {
    expect(stepPreview("first line\n\nsecond paragraph")).toEqual({
      preview: "first line",
      hasMore: true,
      rest: "second paragraph",
    });
  });

  it("does not flag hasMore for trailing whitespace-only lines", () => {
    expect(stepPreview("only line\n   \n")).toEqual({ preview: "only line", hasMore: false, rest: "   \n" });
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "<1s"],
    [999, "<1s"],
    [1000, "1s"],
    [23000, "23s"],
    [65000, "1m 5s"],
    [600000, "10m 0s"],
  ])("%ims -> %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
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
