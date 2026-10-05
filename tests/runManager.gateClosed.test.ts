import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const prompt = { kind: "free_text", id: "prompt-1", message: "Name?" } as const;

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

async function waitingRun() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-gate-closed-"));
  const store = createRunStore({ rootDir: root });
  const agent = scriptedFakeAgent([
    {
      type: "wait_then_emit",
      waitRequests: [prompt],
      envelope: { status: "success", summary: "ok", artifacts: [] },
    },
  ]);
  const manager = new RunManager({ agent, store, cwd: fixtures });
  const closed: Array<[string, string | undefined]> = [];
  manager.onGateClosed((runId, stageId) => closed.push([runId, stageId]));
  const started = await manager.startRun({ pipeline: pipelinePath("single"), task: SAMPLE_TASK });
  if (!started.ok) throw new Error("start failed");
  await waitFor(async () => {
    const detail = await store.readRun(started.runId);
    return detail.stages.find((s) => s.stage_id === "clarify")?.status === "waiting_for_input";
  });
  return { manager, store, runId: started.runId, closed };
}

describe("RunManager gate closed notifications", () => {
  it("notifies when an answer is accepted, not when it is rejected", async () => {
    const { manager, runId, closed } = await waitingRun();
    const rejected = await manager.deliverAnswer(runId, "clarify", {
      promptId: "prompt-1",
      kind: "confirm",
      decision: "accept",
    });
    expect(rejected.ok).toBe(false);
    expect(closed).toEqual([]);

    const accepted = await manager.deliverAnswer(runId, "clarify", {
      promptId: "prompt-1",
      kind: "free_text",
      text: "payments",
    });
    expect(accepted.ok).toBe(true);
    expect(closed).toEqual([[runId, "clarify"]]);
  });

  it("notifies for the whole run when it is cancelled, and stops after unsubscribe", async () => {
    const { manager, runId, closed } = await waitingRun();
    const off = manager.onGateClosed(() => closed.push(["late", undefined]));
    off();
    const result = await manager.cancelRun(runId, "stop");
    expect(result.ok).toBe(true);
    expect(closed).toEqual([[runId, undefined]]);
  });

  it("notifies shutdown listeners once when the Host stops accepting work", async () => {
    const { manager } = await waitingRun();
    let calls = 0;
    const off = manager.onShutdown(() => {
      calls += 1;
    });
    manager.stopAcceptingWork();
    manager.stopAcceptingWork();
    expect(calls).toBe(1);
    off();
  });
});
