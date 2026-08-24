import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StageActivityEvent } from "../src/agent/activity.js";
import type { StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";

async function freshInput(
  overrides: Partial<StageRunInput> = {},
): Promise<StageRunInput> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-stage-handle-"));
  return {
    roots: buildStageRoots(root, "clarify"),
    stage: {
      id: "clarify",
      system_prompt: "clarify",
      model: "fake",
    },
    task: { id: "t1", goal: "goal" },
    priorEnvelope: null,
    ...overrides,
  };
}

const successEnvelope = {
  status: "success" as const,
  summary: "done",
  artifacts: [] as string[],
};

describe("AgentPort stage handle (HITL wait/answer)", () => {
  it("wait → deliverAnswer → emit: result ok only after emit", async () => {
    const seen: StageActivityEvent[] = [];
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: [{ prompt: "need approval" }],
      envelope: successEnvelope,
    });
    const handle = agent.openStage({
      ...(await freshInput()),
      onActivity: (e) => seen.push(e),
    });
    const first = await handle.next();
    expect(first).toEqual({
      status: "waiting_for_input",
      request: { prompt: "need approval" },
    });
    expect(seen.map((e) => e.event)).toContain("agent_start");
    expect(seen.map((e) => e.event)).not.toContain("agent_end");

    handle.deliverAnswer({ text: "approved" });
    expect(agent.receivedAnswers).toEqual([{ text: "approved" }]);

    const second = await handle.next();
    expect(second.status).toBe("completed");
    if (second.status === "completed") {
      expect(second.result.ok).toBe(true);
      if (second.result.ok) {
        expect(second.result.envelope.summary).toBe("done");
      }
    }
    expect(seen.map((e) => e.event).at(-1)).toBe("agent_end");
    await handle.close();
  });

  it("two waits, two answers, then emit (AE2)", async () => {
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["q1", "q2"],
      expectedAnswers: ["a1", "a2"],
      envelope: successEnvelope,
    });
    const handle = agent.openStage(await freshInput());

    expect(await handle.next()).toEqual({
      status: "waiting_for_input",
      request: "q1",
    });
    handle.deliverAnswer("a1");

    expect(await handle.next()).toEqual({
      status: "waiting_for_input",
      request: "q2",
    });
    handle.deliverAnswer("a2");

    const done = await handle.next();
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.result.ok).toBe(true);
    }
    expect(agent.receivedAnswers).toEqual(["a1", "a2"]);
    await handle.close();
  });

  it("deliverAnswer does not by itself complete the stage (AE4)", async () => {
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["q1", "q2"],
      envelope: successEnvelope,
    });
    const handle = agent.openStage(await freshInput());

    expect((await handle.next()).status).toBe("waiting_for_input");
    handle.deliverAnswer("a1");

    const afterAnswer = await handle.next();
    expect(afterAnswer.status).toBe("waiting_for_input");
    if (afterAnswer.status === "waiting_for_input") {
      expect(afterAnswer.request).toBe("q2");
    }

    handle.deliverAnswer("a2");
    const done = await handle.next();
    expect(done.status).toBe("completed");
    await handle.close();
  });

  it("deliverAnswer while not waiting is ignored", async () => {
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["q1"],
      envelope: successEnvelope,
    });
    const handle = agent.openStage(await freshInput());

    handle.deliverAnswer("premature");
    expect(agent.receivedAnswers).toEqual([]);

    expect((await handle.next()).status).toBe("waiting_for_input");
    handle.deliverAnswer("ok");
    expect(agent.receivedAnswers).toEqual(["ok"]);

    const done = await handle.next();
    expect(done.status).toBe("completed");
    await handle.close();
  });

  it("runStage remains a non-wait wrapper for emit behaviors", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: successEnvelope,
    });
    const result = await agent.runStage(await freshInput());
    expect(result.ok).toBe(true);
  });

  it("runStage fails closed if the stage waits", async () => {
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["q1"],
      envelope: successEnvelope,
    });
    const result = await agent.runStage(await freshInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/wait/i);
    }
  });
});
