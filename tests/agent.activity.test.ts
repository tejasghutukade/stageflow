import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT_LIMIT,
  extractMessageText,
  mapSessionEventToActivity,
  truncateActivityText,
  type StageActivityEvent,
} from "../src/agent/activity.js";
import { createStageActivityObserver } from "../src/agent/activityObserver.js";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { deriveStatusFromStages } from "../src/runstore/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { runStage } from "../src/runtime/stageRunner.js";

describe("stage activity observer", () => {
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

  it("truncates long activity text for previews", () => {
    const long = "x".repeat(ACTIVITY_TEXT_LIMIT + 50);
    const truncated = truncateActivityText(long);
    expect(truncated?.endsWith("…")).toBe(true);
    expect(truncated!.length).toBe(ACTIVITY_TEXT_LIMIT + 1);
    expect(extractMessageText({ role: "user", content: long }).text?.length).toBe(
      ACTIVITY_TEXT_LIMIT + 1,
    );
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
