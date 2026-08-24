/**
 * Manual smoke checklist (Pi + console) — epic AE3/AE4 / Verification Contract
 *
 * FakeAgent tests below prove R8/R9/R11/AE5 contracts only. Manual Pi smoke is
 * still required for AE3/AE4 (live wait + restart-while-waiting). Do not treat
 * FakeAgent green alone as epic done.
 *
 * From repo cwd (live catalog: pipelines/plan-review-proving.yaml,
 * tasks/prove-plan-review.yaml; Pi adapter + UI/server):
 *
 * 1. Start UI/server with the Pi agent (not FakeAgent).
 * 2. Start task `prove-plan-review` / pipeline `plan-review-proving`.
 * 3. AE3 — live wait: when plan-review shows artifact_backed waiting_for_input,
 *    Accept in the operator console → plan-review succeeds and
 *    plan-review-followup runs (no unconnected-bridge / completed-only error).
 * 4. Change loop: Reject with text → same plan-review stage waits again;
 *    follow-up must not start; then Accept → follow-up runs.
 * 5. AE4 — restart while waiting: with plan-review waiting_for_input and Pi
 *    session file present, kill and restart the server; answer Accept; run
 *    continues (plan-review completes, follow-up runs).
 * 6. Optional: clarifying free_text / multi_question before the plan gate if
 *    the model offers them — not required for done-bar (R10).
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import {
  normalizePromptIds,
  parseAskOperatorAnswer,
  parseAskOperatorParams,
  type AskOperatorAnswer,
  type AskOperatorPrompt,
} from "../src/tools/askOperator.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const askFixtureDir = path.join(fixtures, "askOperator");

const planReviewEnvelope = {
  status: "success" as const,
  summary: "plan accepted",
  artifacts: ["stages/plan-review/attempts/1/artifacts/plan.md"],
};

const followupEnvelope = {
  status: "success" as const,
  summary: "follow-up ack",
  artifacts: [] as string[],
};

async function loadPair(name: string): Promise<{
  prompt: AskOperatorPrompt;
  answer: AskOperatorAnswer;
}> {
  const raw = await readFile(path.join(askFixtureDir, name), "utf8");
  const fixture = JSON.parse(raw) as { prompt: unknown; answer: unknown };
  return {
    prompt: normalizePromptIds(parseAskOperatorParams(fixture.prompt)),
    answer: parseAskOperatorAnswer(fixture.answer),
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

describe("runtime HITL plan-review proving (U3)", () => {
  it("AE1 FakeAgent: artifact_backed accept → plan-review-followup runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-plan-review-"));
    const store = createRunStore({ rootDir: root });
    const { prompt } = await loadPair("artifact_backed.json");
    const accept: AskOperatorAnswer = {
      promptId: prompt.id,
      kind: "artifact_backed",
      decision: "accept",
    };
    const opened: string[] = [];
    const base = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [prompt],
        expectedAnswers: [accept],
        envelope: planReviewEnvelope,
      },
      { type: "emit", envelope: followupEnvelope },
    ]);
    const agent = {
      openStage(input: Parameters<typeof base.openStage>[0]) {
        opened.push(input.stage.id);
        return base.openStage(input);
      },
      runStage(input: Parameters<typeof base.runStage>[0]) {
        return base.runStage(input);
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "plan-review-proving",
      task: path.join(fixtures, "tasks", "prove-plan-review.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "plan-review")?.status ===
        "waiting_for_input"
      );
    });
    expect(opened).toEqual(["plan-review"]);
    const followupDuringWait = (await store.readRun(started.runId)).stages.find(
      (s) => s.stage_id === "plan-review-followup",
    );
    expect(followupDuringWait?.status).toBe("pending");

    const delivered = await manager.deliverAnswer(
      started.runId,
      "plan-review",
      accept,
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });

    expect(opened).toEqual(["plan-review", "plan-review-followup"]);
    const done = await store.readRun(started.runId);
    expect(
      done.stages.find((s) => s.stage_id === "plan-review")?.status,
    ).toBe("succeeded");
    expect(
      done.stages.find((s) => s.stage_id === "plan-review-followup")?.status,
    ).toBe("succeeded");
  });

  it("AE2 FakeAgent: reject keeps plan-review; accept then follow-up advances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-plan-review-"));
    const store = createRunStore({ rootDir: root });
    const { prompt, answer: reject } = await loadPair("artifact_backed.json");
    const accept: AskOperatorAnswer = {
      promptId: prompt.id,
      kind: "artifact_backed",
      decision: "accept",
    };
    const opened: string[] = [];
    const base = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [prompt, prompt],
        expectedAnswers: [reject, accept],
        envelope: planReviewEnvelope,
      },
      { type: "emit", envelope: followupEnvelope },
    ]);
    const agent = {
      openStage(input: Parameters<typeof base.openStage>[0]) {
        opened.push(input.stage.id);
        return base.openStage(input);
      },
      runStage(input: Parameters<typeof base.runStage>[0]) {
        return base.runStage(input);
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "plan-review-proving",
      task: path.join(fixtures, "tasks", "prove-plan-review.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "plan-review")?.status ===
        "waiting_for_input"
      );
    });
    expect(opened).toEqual(["plan-review"]);

    await manager.deliverAnswer(started.runId, "plan-review", reject);

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      const review = detail.stages.find((s) => s.stage_id === "plan-review");
      return (
        review?.status === "waiting_for_input" &&
        (review.events.filter((e) => e.event === "waiting_for_input").length ??
          0) >= 2
      );
    });
    expect(opened).toEqual(["plan-review"]);
    const followupDuringReject = (await store.readRun(started.runId)).stages.find(
      (s) => s.stage_id === "plan-review-followup",
    );
    expect(followupDuringReject?.status).toBe("pending");

    await manager.deliverAnswer(started.runId, "plan-review", accept);

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });
    expect(opened).toEqual(["plan-review", "plan-review-followup"]);
  });

  it("error: missing resume context fails closed (T1 KTD7)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-plan-review-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      path.join(fixtures, "tasks", "prove-plan-review.yaml"),
      "utf8",
    );
    const run = await store.createRun({
      pipelineId: "plan-review-proving",
      taskYaml,
      taskId: "prove-plan-review",
    });
    await store.ensureStageWorkspace(run.runId, "plan-review");
    await store.appendStageEvent(run.runId, "plan-review", { event: "started" });
    await store.appendStageEvent(run.runId, "plan-review", {
      event: "waiting_for_input",
    });

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: planReviewEnvelope,
      },
    ]);
    const manager2 = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
    });
    await manager2.attachWaitingStages();

    const delivered = await manager2.deliverAnswer(
      run.runId,
      "plan-review",
      "too-late",
    );
    expect(delivered.ok).toBe(false);
    if (!delivered.ok) {
      expect(delivered.reason).toMatch(/missing resume context/i);
    }

    const detail = await store2.readRun(run.runId);
    expect(detail.status).toBe("failed");
    expect(
      detail.stages.find((s) => s.stage_id === "plan-review")?.status,
    ).toBe("failed");
  });

  describe("AE5 four-kind answer delivery (FakeAgent)", () => {
    for (const kind of [
      "free_text",
      "confirm",
      "multi_question",
      "artifact_backed",
    ] as const) {
      it(`${kind}: wait → matching answer → stage succeeds`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), "sf-plan-kinds-"));
        const store = createRunStore({ rootDir: root });
        const { prompt, answer: fixtureAnswer } = await loadPair(`${kind}.json`);
        const answer: AskOperatorAnswer =
          kind === "artifact_backed"
            ? {
                promptId: prompt.id,
                kind: "artifact_backed",
                decision: "accept",
              }
            : fixtureAnswer;
        const agent = scriptedFakeAgent([
          {
            type: "wait_then_emit",
            waitRequests: [prompt],
            expectedAnswers: [answer],
            envelope: {
              status: "success",
              summary: `${kind}-ok`,
              artifacts: [],
            },
          },
        ]);
        const manager = new RunManager({ agent, store, cwd: fixtures });
        const started = await manager.startRun({
          pipeline: "single",
          task: path.join(fixtures, "tasks", "sample.yaml"),
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

        const delivered = await manager.deliverAnswer(
          started.runId,
          "clarify",
          answer,
        );
        expect(delivered.ok).toBe(true);

        await waitFor(async () => {
          const detail = await store.readRun(started.runId);
          return detail.status === "succeeded";
        });
      });
    }
  });

  describe("manual Pi + console smoke (AE3/AE4) — not CI", () => {
    it.todo(
      "AE3: live Pi openStage wait on prove-plan-review; console Accept advances to plan-review-followup",
    );
    it.todo(
      "AE4: kill/restart server while plan-review waiting with Pi session present; answer continues run",
    );
  });
});
