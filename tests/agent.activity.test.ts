import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_TEXT_LIMIT,
  ACTIVITY_TEXT_LIMIT_ENV,
  ACTIVITY_VERBOSE_ENV,
  extractMessageText,
  mapSessionEventToActivity,
  readActivityTextLimit,
  readActivityVerbose,
  truncateActivityText,
  type StageActivityEvent,
} from "../src/agent/activity.js";
import { createStageActivityObserver } from "../src/agent/activityObserver.js";
import {
  extractPartialResultText,
  routeSessionEventToProgress,
} from "../src/agent/piAdapter.js";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { deriveStatusFromStages } from "../src/runstore/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { runStage } from "../src/runtime/stageRunner.js";

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
  return {
    text: () => chunks.join(""),
    restore: () => spy.mockRestore(),
  };
}

describe("stage activity observer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards StageActivityEvent to onActivity in order", () => {
    const seen: StageActivityEvent[] = [];
    const observer = createStageActivityObserver({
      onActivity: (e) => seen.push(e),
      writeStderr: false,
    });
    observer.onActivity({ event: "agent_start" });
    observer.onActivity({
      event: "tool_start",
      toolName: "read",
      toolCallId: "c1",
    });
    observer.onActivity({ event: "agent_end" });
    expect(seen.map((e) => e.event)).toEqual([
      "agent_start",
      "tool_start",
      "agent_end",
    ]);
  });

  it("maps Pi-shaped records at the adapter edge before observe", () => {
    const seen: StageActivityEvent[] = [];
    const observer = createStageActivityObserver({
      onActivity: (e) => seen.push(e),
      writeStderr: false,
    });
    const mapped = mapSessionEventToActivity({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "c1",
      args: { path: "a.ts" },
    });
    expect(mapped).not.toBeNull();
    if (mapped) observer.onActivity(mapped);
    expect(seen).toEqual([
      {
        event: "tool_start",
        toolName: "read",
        toolCallId: "c1",
        argsPreview: '{"path":"a.ts"}',
      },
    ]);
    expect(
      mapSessionEventToActivity({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "x" },
      }),
    ).toBeNull();
  });

  it("maps bash tool_start argsPreview from command object", () => {
    const mapped = mapSessionEventToActivity({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "b1",
      args: { command: "ls -la" },
    });
    expect(mapped).toEqual({
      event: "tool_start",
      toolName: "bash",
      toolCallId: "b1",
      argsPreview: '{"command":"ls -la"}',
    });
  });

  it("truncates long activity text for previews", () => {
    const long = "x".repeat(ACTIVITY_TEXT_LIMIT + 50);
    const truncated = truncateActivityText(long);
    expect(truncated?.endsWith("…")).toBe(true);
    expect(truncated!.length).toBe(ACTIVITY_TEXT_LIMIT + 1);
    expect(extractMessageText({ role: "user", content: long }).text?.length).toBe(
      ACTIVITY_TEXT_LIMIT + 1,
    );
  });

  it("tool_start stderr includes tool name and argsPreview", () => {
    const stderr = captureStderr();
    const observer = createStageActivityObserver({ writeStderr: true });
    observer.onActivity({
      event: "tool_start",
      toolName: "bash",
      argsPreview: '{"command":"echo hi"}',
    });
    expect(stderr.text()).toContain("→ bash");
    expect(stderr.text()).toContain('{"command":"echo hi"}');
    stderr.restore();
  });

  it("tool_end stderr includes resultPreview; errors keep ✕", () => {
    const stderr = captureStderr();
    const observer = createStageActivityObserver({ writeStderr: true });
    observer.onActivity({
      event: "tool_end",
      toolName: "bash",
      resultPreview: "hello\nworld",
    });
    observer.onActivity({
      event: "tool_end",
      toolName: "bash",
      isError: true,
      resultPreview: "boom",
    });
    const text = stderr.text();
    expect(text).toContain("← bash");
    expect(text).toContain("hello");
    expect(text).toContain("✕ bash");
    expect(text).toContain("boom");
    stderr.restore();
  });

  it("tool events without previews print tool name only", () => {
    const stderr = captureStderr();
    const observer = createStageActivityObserver({ writeStderr: true });
    observer.onActivity({ event: "tool_start", toolName: "read" });
    observer.onActivity({ event: "tool_end", toolName: "read", isError: true });
    const text = stderr.text();
    expect(text).toContain("→ read");
    expect(text).toContain("✕ read");
    expect(text).not.toContain("undefined");
    stderr.restore();
  });

  it("does not reprint assistant message after streamed deltas", () => {
    const stderr = captureStderr();
    const observer = createStageActivityObserver({ writeStderr: true });
    observer.onAssistantTextDelta("Hello");
    observer.onAssistantTextDelta(" world");
    observer.onStreamBoundary();
    observer.onActivity({
      event: "message",
      role: "assistant",
      text: "Hello world",
    });
    const text = stderr.text();
    expect(text).toContain("Hello world");
    expect(text.indexOf("Hello world")).toBe(text.lastIndexOf("Hello world"));
    stderr.restore();
  });

  it("prints non-assistant message text once", () => {
    const stderr = captureStderr();
    const observer = createStageActivityObserver({ writeStderr: true });
    observer.onActivity({
      event: "message",
      role: "user",
      text: "please run tests",
    });
    expect(stderr.text()).toContain("please run tests");
    stderr.restore();
  });

  it("FakeAgent emits onActivity milestones", async () => {
    const seen: StageActivityEvent[] = [];
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "done",
        artifacts: [],
      },
    });
    const result = await agent.runStage({
      roots: buildStageRoots("/tmp", "s"),
      stage: { id: "s", model: "fake", system_prompt: "x" },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
      onActivity: (e) => seen.push(e),
    });
    expect(result.ok).toBe(true);
    expect(seen.map((e) => e.event)).toEqual([
      "agent_start",
      "tool_start",
      "tool_end",
      "message",
      "agent_end",
    ]);
  });

  it("interleaved activity lines do not break catalog status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-act-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: demo\n",
      taskId: "t",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "agent_start" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "tool_start",
      toolName: "read",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });

    const detail = await store.readRun(run.runId);
    expect(detail.stages[0]?.status).toBe("succeeded");
    expect(detail.status).toBe("succeeded");
    expect(detail.stages[0]?.events.some((e) => e.event === "tool_start")).toBe(
      true,
    );
    expect(
      deriveStatusFromStages([
        {
          stage_id: "clarify",
          status: "succeeded",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("succeeded");
  });

  it("stageRunner persists FakeAgent activity via RunStore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-act-run-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: demo\n",
      taskId: "t",
    });
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "ok",
        artifacts: [],
        payload: { n: 1 },
      },
    });
    const result = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: { id: "clarify", model: "fake", system_prompt: "x" },
      task: { id: "t", goal: "demo" },
      priorEnvelope: null,
    });
    expect(result.ok).toBe(true);
    const detail = await store.readRun(run.runId);
    const events = detail.stages[0]?.events.map((e) => e.event) ?? [];
    expect(events[0]).toBe("started");
    expect(events).toContain("tool_start");
    expect(events).toContain("message");
    expect(events.at(-1)).toBe("succeeded");
    expect(detail.stages[0]?.envelope?.payload).toEqual({ n: 1 });
  });
});

describe("activity text limit env", () => {
  it("defaults to 2000 and truncates with ellipsis", () => {
    expect(ACTIVITY_TEXT_LIMIT).toBe(2000);
    expect(readActivityTextLimit({})).toBe(2000);
    const long = "y".repeat(2500);
    const truncated = truncateActivityText(long, readActivityTextLimit({}));
    expect(truncated!.length).toBe(2001);
    expect(truncated?.endsWith("…")).toBe(true);
  });

  it("reads STAGEFLOW_ACTIVITY_TEXT_LIMIT and falls back on invalid", () => {
    expect(
      readActivityTextLimit({ [ACTIVITY_TEXT_LIMIT_ENV]: "120" }),
    ).toBe(120);
    expect(
      readActivityTextLimit({ [ACTIVITY_TEXT_LIMIT_ENV]: "" }),
    ).toBe(ACTIVITY_TEXT_LIMIT);
    expect(
      readActivityTextLimit({ [ACTIVITY_TEXT_LIMIT_ENV]: "nope" }),
    ).toBe(ACTIVITY_TEXT_LIMIT);
    expect(
      readActivityTextLimit({ [ACTIVITY_TEXT_LIMIT_ENV]: "0" }),
    ).toBe(ACTIVITY_TEXT_LIMIT);
  });

  it("override wins over env", () => {
    expect(
      readActivityTextLimit({ [ACTIVITY_TEXT_LIMIT_ENV]: "50" }, 80),
    ).toBe(80);
    expect(
      readActivityTextLimit({ [ACTIVITY_TEXT_LIMIT_ENV]: "50" }, 0),
    ).toBe(ACTIVITY_TEXT_LIMIT);
  });

  it("mapped tool_end preview length matches configured limit", () => {
    const limit = 40;
    const result = { content: [{ type: "text", text: "z".repeat(100) }] };
    const preview = truncateActivityText(result, limit);
    expect(preview!.length).toBe(limit + 1);
    const mapped = mapSessionEventToActivity({
      type: "tool_execution_end",
      toolName: "bash",
      result,
      isError: false,
    });
    expect(mapped?.event).toBe("tool_end");
    if (mapped?.event === "tool_end") {
      expect(mapped.resultPreview!.length).toBeLessThanOrEqual(
        readActivityTextLimit() + 1,
      );
    }
    expect(preview).toBe(truncateActivityText(result, limit));
  });
});

describe("activity verbose routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readActivityVerbose gates on env values", () => {
    expect(readActivityVerbose({})).toBe(false);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "" })).toBe(false);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "0" })).toBe(false);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "false" })).toBe(
      false,
    );
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "OFF" })).toBe(false);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "no" })).toBe(false);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "1" })).toBe(true);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "true" })).toBe(true);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "yes" })).toBe(true);
    expect(readActivityVerbose({}, true)).toBe(true);
    expect(readActivityVerbose({ [ACTIVITY_VERBOSE_ENV]: "1" }, false)).toBe(
      false,
    );
  });

  it("verbose off ignores thinking and tool_execution_update", () => {
    const stderr = captureStderr();
    const seen: StageActivityEvent[] = [];
    const observer = createStageActivityObserver({
      onActivity: (e) => seen.push(e),
      writeStderr: true,
    });
    routeSessionEventToProgress(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "secret" },
      },
      { observer, verbose: false },
    );
    routeSessionEventToProgress(
      {
        type: "tool_execution_update",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text: "partial" }],
        },
      },
      { observer, verbose: false },
    );
    expect(stderr.text()).not.toContain("secret");
    expect(stderr.text()).not.toContain("partial");
    expect(seen).toEqual([]);
    stderr.restore();
  });

  it("verbose on streams thinking with distinct prefix", () => {
    const stderr = captureStderr();
    const observer = createStageActivityObserver({ writeStderr: true });
    routeSessionEventToProgress(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "ponder" },
      },
      { observer, verbose: true },
    );
    routeSessionEventToProgress(
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "answer" },
      },
      { observer, verbose: true },
    );
    const text = stderr.text();
    expect(text).toContain("∴ ");
    expect(text).toContain("ponder");
    expect(text).toContain("answer");
    stderr.restore();
  });

  it("verbose on suffix-diffs partialResult between tool_start and tool_end", () => {
    const stderr = captureStderr();
    const seen: StageActivityEvent[] = [];
    const observer = createStageActivityObserver({
      onActivity: (e) => seen.push(e),
      writeStderr: true,
    });
    routeSessionEventToProgress(
      {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "c1",
        args: { command: "echo" },
      },
      { observer, verbose: true },
    );
    routeSessionEventToProgress(
      {
        type: "tool_execution_update",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text: "ab" }],
        },
      },
      { observer, verbose: true },
    );
    routeSessionEventToProgress(
      {
        type: "tool_execution_update",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text: "abcd" }],
        },
      },
      { observer, verbose: true },
    );
    routeSessionEventToProgress(
      {
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "c1",
        result: { content: [{ type: "text", text: "abcd" }] },
        isError: false,
      },
      { observer, verbose: true },
    );
    const text = stderr.text();
    expect(text).toContain("→ bash");
    expect(text).toContain("│ ");
    expect(text).toContain("ab");
    expect(text).toContain("cd");
    expect(text.match(/abcd/g)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(seen.map((e) => e.event)).toEqual(["tool_start", "tool_end"]);
    stderr.restore();
  });

  it("extractPartialResultText prefers content text blocks", () => {
    expect(
      extractPartialResultText({
        content: [{ type: "text", text: "live out" }],
      }),
    ).toBe("live out");
    expect(extractPartialResultText("raw")).toBe("raw");
  });
});
