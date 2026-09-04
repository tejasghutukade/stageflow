import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeAgent, scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  AskOperatorWaitChannel,
  createUnconnectedAskWaitBridge,
  resolveStageToolNames,
} from "../src/agent/piAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import {
  t2AssertAnswerMatchesPrompt,
  tryParsePendingPrompt,
} from "../src/runtime/stageHitl.js";
import {
  createAskOperatorTool,
  type AskOperatorPrompt,
} from "../src/tools/askOperator.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const successEnvelope = {
  status: "success" as const,
  summary: "done",
  artifacts: [] as string[],
};

const freeTextPrompt: AskOperatorPrompt = {
  kind: "free_text",
  id: "prompt-1",
  message: "What should the module name be?",
};

const freeTextAnswer = {
  promptId: "prompt-1",
  kind: "free_text" as const,
  text: "payments",
};

const freeTextPrompt2: AskOperatorPrompt = {
  kind: "free_text",
  id: "prompt-2",
  message: "Owner?",
};

const freeTextAnswer2 = {
  promptId: "prompt-2",
  kind: "free_text" as const,
  text: "tejas",
};

async function freshInput(): Promise<StageRunInput> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-ask-wire-"));
  return {
    roots: buildStageRoots(root, "clarify"),
    stage: {
      id: "clarify",
      system_prompt: "clarify",
      model: "fake",
    },
    task: { id: "t1", goal: "goal" },
    priorEnvelope: null,
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

describe("ask_operator wiring (U3)", () => {
  it("allowlist includes ask_operator beside emit (and artifact when registered)", () => {
    expect(resolveStageToolNames("emit_stage_envelope")).toEqual([
      "read",
      "bash",
      "write",
      "edit",
      "emit_stage_envelope",
      "ask_operator",
    ]);
    expect(
      resolveStageToolNames("emit_stage_envelope", "write_stage_artifact"),
    ).toEqual([
      "read",
      "bash",
      "write",
      "edit",
      "emit_stage_envelope",
      "ask_operator",
      "write_stage_artifact",
    ]);
  });

  it("empty gate_kinds omits ask_operator from the sealed-session allowlist (AE5)", () => {
    expect(
      resolveStageToolNames(
        "emit_stage_envelope",
        undefined,
        "ask_operator",
        [],
      ),
    ).toEqual(["read", "bash", "write", "edit", "emit_stage_envelope"]);
    expect(
      resolveStageToolNames(
        "emit_stage_envelope",
        "write_stage_artifact",
        "ask_operator",
        [],
      ),
    ).toEqual([
      "read",
      "bash",
      "write",
      "edit",
      "emit_stage_envelope",
      "write_stage_artifact",
    ]);
    expect(
      resolveStageToolNames(
        "emit_stage_envelope",
        undefined,
        "ask_operator",
        ["confirm"],
      ),
    ).toContain("ask_operator");
  });

  it("non-empty gate_kinds allowlists kinds on the ask tool", async () => {
    const channel = new AskOperatorWaitChannel();
    channel.setWaitHandler(() => {});
    const tool = createAskOperatorTool({
      requestWait: (prompt) => channel.requestWait(prompt),
      allowedKinds: ["confirm"],
    });

    const undeclared = await tool.execute("t-deny", {
      kind: "free_text",
      message: "Write a report only?",
    });
    expect(undeclared.isError).toBe(true);
    expect(undeclared.details.error).toMatch(/free_text/);
    expect(undeclared.details.prompt).toBeNull();

    const exec = tool.execute("t-ok", {
      kind: "confirm",
      id: "prompt-ok",
      message: "Proceed?",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.hasPending).toBe(true);
    expect(
      channel.deliverAnswer({
        promptId: "prompt-ok",
        kind: "confirm",
        decision: "accept",
      }),
    ).toBe(true);
    const declared = await exec;
    expect(declared.isError).toBeUndefined();
    expect(declared.details).toMatchObject({
      prompt: { kind: "confirm", id: "prompt-ok" },
    });
  });

  it("FakeAgent wait with T2 free_text opaque + deliverAnswer unblocks without success until emit", async () => {
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: [freeTextPrompt],
      envelope: successEnvelope,
    });
    const handle = agent.openStage(await freshInput());

    const first = await handle.next();
    expect(first).toEqual({
      status: "waiting_for_input",
      request: freeTextPrompt,
    });
    expect(tryParsePendingPrompt(freeTextPrompt)?.id).toBe("prompt-1");

    handle.deliverAnswer(freeTextAnswer);
    expect(agent.receivedAnswers).toEqual([freeTextAnswer]);

    const second = await handle.next();
    expect(second.status).toBe("completed");
    if (second.status === "completed") {
      expect(second.result.ok).toBe(true);
    }
    await handle.close();
  });

  it("multiple waits with distinct prompt IDs then emit (AE4)", async () => {
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: [freeTextPrompt, freeTextPrompt2],
      expectedAnswers: [freeTextAnswer, freeTextAnswer2],
      envelope: successEnvelope,
    });
    const handle = agent.openStage(await freshInput());

    expect(await handle.next()).toMatchObject({
      status: "waiting_for_input",
      request: { id: "prompt-1" },
    });
    handle.deliverAnswer(freeTextAnswer);

    const secondWait = await handle.next();
    expect(secondWait.status).toBe("waiting_for_input");
    if (secondWait.status === "waiting_for_input") {
      expect(secondWait.request).toMatchObject({ id: "prompt-2" });
    }
    handle.deliverAnswer(freeTextAnswer2);

    const done = await handle.next();
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.result.ok).toBe(true);
    }
    expect(agent.receivedAnswers).toEqual([freeTextAnswer, freeTextAnswer2]);
    await handle.close();
  });

  it("regression: emit-only FakeAgent unchanged", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: successEnvelope,
    });
    const result = await agent.runStage(await freshInput());
    expect(result.ok).toBe(true);
  });

  it("deliverAnswer rejects mismatched T2 answer via HitlSeams assert", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-ask-assert-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
        },
      },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: SAMPLE_TASK,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status ===
        "waiting_for_input"
      );
    });

    const rejected = await manager.deliverAnswer(started.runId, "clarify", {
      promptId: "prompt-1",
      kind: "confirm",
      decision: "accept",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.status).toBe(400);
      expect(rejected.reason).toMatch(/kind/i);
    }

    const stillWaiting = await store.readRun(started.runId);
    expect(
      stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");

    const accepted = await manager.deliverAnswer(
      started.runId,
      "clarify",
      freeTextAnswer,
    );
    expect(accepted.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });
  });

  it("t2AssertAnswerMatchesPrompt leaves non-T2 opaques alone", () => {
    expect(() =>
      t2AssertAnswerMatchesPrompt({
        runId: "r",
        stageId: "s",
        answer: "approved",
        pendingRequest: "need-input",
      }),
    ).not.toThrow();
  });

  it("AskOperatorWaitChannel bridges tool wait to deliverAnswer", async () => {
    const channel = new AskOperatorWaitChannel();
    const seen: AskOperatorPrompt[] = [];
    channel.setWaitHandler((prompt) => {
      seen.push(prompt);
    });
    const tool = createAskOperatorTool({
      requestWait: (prompt) => channel.requestWait(prompt),
    });

    const exec = tool.execute("t1", {
      kind: "free_text",
      id: "prompt-1",
      message: "Name?",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(channel.hasPending).toBe(true);
    expect(channel.deliverAnswer(freeTextAnswer)).toBe(true);

    const result = await exec;
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      prompt: { id: "prompt-1", kind: "free_text" },
      answer: freeTextAnswer,
    });
  });

  it("unconnected Pi wait bridge fails closed", async () => {
    const bridge = createUnconnectedAskWaitBridge();
    await expect(
      bridge.requestWait(freeTextPrompt),
    ).rejects.toThrow(/not connected/i);
  });
});
