import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeHitlResumePath,
  scriptedFakeAgent,
} from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { pipelinePath, catalogLocators, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const okEnvelope = (
  summary: string,
  artifacts: string[] = [],
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts,
});

const promptA: AskOperatorPrompt = {
  kind: "free_text",
  id: "prompt-a",
  message: "Question for branch A?",
};

const promptB: AskOperatorPrompt = {
  kind: "free_text",
  id: "prompt-b",
  message: "Question for branch B?",
};

const answerA = {
  promptId: "prompt-a",
  kind: "free_text" as const,
  text: "answer-a",
};

const answerB = {
  promptId: "prompt-b",
  kind: "free_text" as const,
  text: "answer-b",
};

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

function multiWaitAgent(options?: {
  branchA?: {
    waitRequests: AskOperatorPrompt[];
    expectedAnswers?: unknown[];
    envelope: StageEnvelope;
  };
  branchB?: {
    waitRequests: AskOperatorPrompt[];
    expectedAnswers?: unknown[];
    envelope: StageEnvelope;
  };
}) {
  const clarifyAgent = scriptedFakeAgent([
    { type: "emit", envelope: okEnvelope("ancestor") },
  ]);
  const branchAAgent = scriptedFakeAgent([
    {
      type: "wait_then_emit",
      waitRequests: options?.branchA?.waitRequests ?? [promptA],
      expectedAnswers: options?.branchA?.expectedAnswers,
      envelope: options?.branchA?.envelope ?? okEnvelope("branch-a"),
    },
  ]);
  const branchBAgent = scriptedFakeAgent([
    {
      type: "wait_then_emit",
      waitRequests: options?.branchB?.waitRequests ?? [promptB],
      expectedAnswers: options?.branchB?.expectedAnswers,
      envelope: options?.branchB?.envelope ?? okEnvelope("branch-b"),
    },
  ]);
  const branchCAgent = scriptedFakeAgent([
    {
      type: "emit",
      envelope: options?.branchB?.envelope ?? okEnvelope("branch-c"),
    },
  ]);

  const opened: string[] = [];
  return {
    opened,
    agent: {
      openStage(input: Parameters<typeof clarifyAgent.openStage>[0]) {
        opened.push(input.stage.id);
        if (input.stage.id === "clarify") return clarifyAgent.openStage(input);
        if (input.stage.id === "branch-a") return branchAAgent.openStage(input);
        if (input.stage.id === "branch-b") return branchBAgent.openStage(input);
        if (input.stage.id === "branch-c") return branchCAgent.openStage(input);
        return clarifyAgent.openStage(input);
      },
      runStage(input: Parameters<typeof clarifyAgent.runStage>[0]) {
        const handle = this.openStage(input);
        return (async () => {
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false as const, reason: "wait" };
          }
          return event.result;
        })();
      },
    },
  };
}

async function startMultiWaitRun(
  store: ReturnType<typeof createRunStore>,
  agent: ReturnType<typeof multiWaitAgent>["agent"],
) {
  const manager = new RunManager({ agent, store, cwd: fixtures });
  const started = await manager.startRun({
    pipeline: pipelinePath("parallel-hitl-multi-wait"),
    task: SAMPLE_TASK,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("start failed");
  return { manager, runId: started.runId };
}

async function waitForDualWait(
  store: ReturnType<typeof createRunStore>,
  runId: string,
): Promise<void> {
  await waitFor(async () => {
    const detail = await store.readRun(runId);
    const a = detail.stages.find((s) => s.stage_id === "branch-a");
    const b = detail.stages.find((s) => s.stage_id === "branch-b");
    return a?.status === "waiting_for_input" && b?.status === "waiting_for_input";
  });
}

describe("runtime HITL multi-wait (T3 U3)", () => {
  it("AE1: simultaneous sibling waits with distinct pending prompts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-mw-"));
    const store = createRunStore({ rootDir: root });
    const { runId } = await startMultiWaitRun(store, multiWaitAgent().agent);

    await waitForDualWait(store, runId);

    const detail = await store.readRun(runId);
    const branchA = detail.stages.find((s) => s.stage_id === "branch-a")!;
    const branchB = detail.stages.find((s) => s.stage_id === "branch-b")!;
    expect(branchA.status).toBe("waiting_for_input");
    expect(branchB.status).toBe("waiting_for_input");
    expect(branchA.pending_prompt?.message).toBe("Question for branch A?");
    expect(branchB.pending_prompt?.message).toBe("Question for branch B?");
    expect(detail.waiting_stage_ids).toEqual(["branch-a", "branch-b"]);
    expect(detail.waiting_stage_id).toBe("branch-a");
  });

  it("AE2: answer branch-a only; branch-b stays waiting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-mw-"));
    const store = createRunStore({ rootDir: root });
    const { manager, runId } = await startMultiWaitRun(
      store,
      multiWaitAgent().agent,
    );

    await waitForDualWait(store, runId);

    const beforeB = await store.readRun(runId);
    const branchBPromptBefore = beforeB.stages.find(
      (s) => s.stage_id === "branch-b",
    )?.pending_prompt;

    const delivered = await manager.deliverAnswer(runId, "branch-a", answerA);
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(runId);
      const branchA = detail.stages.find((s) => s.stage_id === "branch-a");
      return branchA?.status === "succeeded";
    });

    const after = await store.readRun(runId);
    const branchB = after.stages.find((s) => s.stage_id === "branch-b")!;
    expect(branchB.status).toBe("waiting_for_input");
    expect(branchB.pending_prompt).toEqual(branchBPromptBefore);
    expect(after.waiting_stage_ids).toEqual(["branch-b"]);
  });

  it("AE3: branch-c runs while branch-a waits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-mw-"));
    const store = createRunStore({ rootDir: root });
    const { opened, agent } = multiWaitAgent();
    const { runId } = await startMultiWaitRun(store, agent);

    await waitFor(async () => {
      const detail = await store.readRun(runId);
      return (
        detail.stages.find((s) => s.stage_id === "branch-a")?.status ===
        "waiting_for_input"
      );
    });

    expect(opened).toContain("branch-c");
    const detail = await store.readRun(runId);
    expect(
      detail.stages.find((s) => s.stage_id === "branch-c")?.status,
    ).toBe("succeeded");
    expect(
      detail.stages.find((s) => s.stage_id === "branch-a")?.status,
    ).toBe("waiting_for_input");
  });

  it("AE4: wrong-stage answer rejected; sibling waiter unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-mw-"));
    const store = createRunStore({ rootDir: root });
    const { manager, runId } = await startMultiWaitRun(
      store,
      multiWaitAgent().agent,
    );

    await waitForDualWait(store, runId);

    const rejected = await manager.deliverAnswer(runId, "clarify", answerA);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.status).toBe(409);
    }

    const after = await store.readRun(runId);
    expect(
      after.stages.find((s) => s.stage_id === "branch-a")?.status,
    ).toBe("waiting_for_input");
    expect(
      after.stages.find((s) => s.stage_id === "branch-b")?.status,
    ).toBe("waiting_for_input");
  });

  it("AE5: restart attach keeps both waiters answerable independently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-mw-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = "id: sample\ngoal: multi-wait\n";
    const run = await store.createRun({
      ...catalogLocators("parallel-hitl-multi-wait"),
      taskYaml,
      taskId: "sample",
    });
    const roots = buildStageRoots(run.workspaceDir, "clarify");
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", okEnvelope("ancestor"));
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    for (const stageId of ["branch-a", "branch-b"] as const) {
      await store.ensureStageWorkspace(run.runId, stageId);
      await store.appendStageEvent(run.runId, stageId, { event: "started" });
      const resumePath = fakeHitlResumePath(roots, stageId);
      await writeFile(
        resumePath,
        `${JSON.stringify({
          waitRequests: [stageId === "branch-a" ? promptA : promptB],
          envelope: okEnvelope(stageId),
          waitIndex: 1,
        })}\n`,
        "utf8",
      );
      await store.appendStageEvent(run.runId, stageId, {
        event: "waiting_for_input",
      });
    }

    const store2 = createRunStore({ rootDir: root });
    const agent2 = multiWaitAgent().agent;
    const manager2 = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
    });
    const attached = await manager2.attachWaitingStages();
    expect(attached).toEqual(
      expect.arrayContaining([
        { runId: run.runId, stageId: "branch-a" },
        { runId: run.runId, stageId: "branch-b" },
      ]),
    );
    expect(attached).toHaveLength(2);

    const first = await manager2.deliverAnswer(run.runId, "branch-a", answerA);
    expect(first.ok).toBe(true);
    await waitFor(async () => {
      const detail = await store2.readRun(run.runId);
      return (
        detail.stages.find((s) => s.stage_id === "branch-a")?.status ===
        "succeeded"
      );
    });

    const stillB = await store2.readRun(run.runId);
    expect(
      stillB.stages.find((s) => s.stage_id === "branch-b")?.status,
    ).toBe("waiting_for_input");

    const second = await manager2.deliverAnswer(run.runId, "branch-b", answerB);
    expect(second.ok).toBe(true);
    await waitFor(async () => {
      const detail = await store2.readRun(run.runId);
      return detail.status === "succeeded";
    });
  });

  it("AE6: branch-a second wait while branch-b still waiting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-mw-"));
    const store = createRunStore({ rootDir: root });
    const promptA2: AskOperatorPrompt = {
      kind: "free_text",
      id: "prompt-a-2",
      message: "Second question for branch A?",
    };
    const answerA2 = {
      promptId: "prompt-a-2",
      kind: "free_text" as const,
      text: "answer-a-2",
    };
    const { manager, runId } = await startMultiWaitRun(
      store,
      multiWaitAgent({
        branchA: {
          waitRequests: [promptA, promptA2],
          expectedAnswers: [answerA, answerA2],
          envelope: okEnvelope("branch-a"),
        },
      }).agent,
    );

    await waitForDualWait(store, runId);

    await manager.deliverAnswer(runId, "branch-a", answerA);

    await waitFor(async () => {
      const detail = await store.readRun(runId);
      const branchA = detail.stages.find((s) => s.stage_id === "branch-a");
      const branchB = detail.stages.find((s) => s.stage_id === "branch-b");
      return (
        branchA?.status === "waiting_for_input" &&
        branchB?.status === "waiting_for_input" &&
        branchA.pending_prompt?.id === "prompt-a-2"
      );
    });

    const delivered = await manager.deliverAnswer(runId, "branch-a", answerA2);
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(runId);
      return (
        detail.stages.find((s) => s.stage_id === "branch-a")?.status ===
        "succeeded"
      );
    });

    const after = await store.readRun(runId);
    expect(
      after.stages.find((s) => s.stage_id === "branch-b")?.status,
    ).toBe("waiting_for_input");
    expect(after.waiting_stage_ids).toEqual(["branch-b"]);
  });
});
