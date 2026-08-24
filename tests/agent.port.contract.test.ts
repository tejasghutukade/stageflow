import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-port-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const baseInput: StageRunInput = {
  roots: buildStageRoots("/tmp", "clarify"),
  stage: {
    id: "clarify",
    system_prompt: "clarify",
    model: "anthropic/claude-sonnet-4-5",
  },
  task: { id: "t1", goal: "goal" },
  priorEnvelope: null,
};

describe("AgentPort contract", () => {
  it("fake agent emit success returns checked envelope", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "ok",
        artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
      },
    });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.summary).toBe("ok");
    }
  });

  it("fake agent that never emits yields failure", async () => {
    const agent = new FakeAgent({ type: "never_emit" });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(false);
  });

  it("emit tool rejects missing required fields", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    const out = await tool.execute("1", {
      status: "success",
      summary: "x",
    });
    expect(out.isError).toBe(true);
    expect(capture).not.toHaveProperty("envelope");
  });

  it("emit with status:failure yields stage failure", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "failure",
        summary: "blocked",
        artifacts: [],
      },
    });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.envelope?.status).toBe("failure");
    }
  });

  it("ignores later emit_stage_envelope calls after first valid envelope", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    await tool.execute("1", {
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    await tool.execute("2", {
      status: "success",
      summary: "should be ignored",
      artifacts: ["x.md"],
    });
    expect(capture).toMatchObject({
      envelope: { status: "failure", summary: "blocked" },
    });
    expect(capture.envelope?.status).toBe("failure");
  });

  it("priorEnvelope null is accepted for first-stage calls", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: { status: "success", summary: "ok", artifacts: [] },
    });
    await expect(agent.runStage({ ...baseInput, priorEnvelope: null })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("FakeAgent parks and resumes via its HITL file, ignoring resumeToken", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const input: StageRunInput = {
      ...baseInput,
      roots,
      resumeToken: "/not/a/pi/session.jsonl",
    };
    const behavior = {
      type: "wait_then_emit" as const,
      waitRequests: ["need-input"],
      envelope: { status: "success", summary: "ok", artifacts: [] },
    };

    const first = new FakeAgent(behavior).openStage(input);
    const waiting = await first.next();
    expect(waiting.status).toBe("waiting_for_input");
    await first.close({ park: true });

    const resumed = new FakeAgent(behavior).openStage(input);
    resumed.deliverAnswer("go");
    const done = await resumed.next();
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.result).toEqual({
        ok: true,
        envelope: { status: "success", summary: "ok", artifacts: [] },
      });
    }
    await resumed.close();
  });

  it("runStage fail-closes when the handle waits", async () => {
    const runWs = await makeTempDir();
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["need-input"],
      envelope: { status: "success", summary: "ok", artifacts: [] },
    });
    const result = await agent.runStage({
      ...baseInput,
      roots: buildStageRoots(runWs, "clarify"),
    });
    expect(result).toEqual({
      ok: false,
      reason: "stage requested wait; use openStage/deliverAnswer",
    });
  });
});
