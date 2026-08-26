import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
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

const successEnvelope = {
  status: "success" as const,
  summary: "done",
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

describe("runtime HITL durable Q&A ordering (T3 U2)", () => {
  it("F1: operator_prompt then waiting_for_input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-qa-"));
    const store = createRunStore({ rootDir: root });
    const { prompt, answer } = await loadPair("free_text.json");
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [prompt],
        expectedAnswers: [answer],
        envelope: successEnvelope,
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

    const events = await store.listStageEvents(started.runId, "clarify");
    const names = events.map((e) => e.event);
    const promptIdx = names.indexOf("operator_prompt");
    const waitIdx = names.indexOf("waiting_for_input");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeGreaterThan(promptIdx);
    expect(events[promptIdx]).toMatchObject({
      event: "operator_prompt",
      prompt,
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

  it("F2: operator_answer before resumed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-qa-"));
    const store = createRunStore({ rootDir: root });
    const { prompt, answer } = await loadPair("confirm.json");
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [prompt],
        expectedAnswers: [answer],
        envelope: successEnvelope,
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

    const delivered = await manager.deliverAnswer(
      started.runId,
      "clarify",
      answer,
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const events = await store.listStageEvents(started.runId, "clarify");
      return events.some((e) => e.event === "resumed");
    });

    const events = await store.listStageEvents(started.runId, "clarify");
    const names = events.map((e) => e.event);
    const answerIdx = names.indexOf("operator_answer");
    const resumedIdx = names.indexOf("resumed");
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    expect(resumedIdx).toBeGreaterThan(answerIdx);
    expect(events[answerIdx]).toMatchObject({
      event: "operator_answer",
      promptId: answer.promptId,
      answer,
    });

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });
  });

  it("mismatched promptId: assert rejects; no operator_answer on trail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-qa-"));
    const store = createRunStore({ rootDir: root });
    const { prompt, answer } = await loadPair("free_text.json");
    const badAnswer: AskOperatorAnswer = {
      ...answer,
      promptId: "not-the-prompt-id",
    };
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [prompt],
        envelope: successEnvelope,
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

    const before = await store.listStageEvents(started.runId, "clarify");
    expect(before.some((e) => e.event === "operator_prompt")).toBe(true);
    expect(before.some((e) => e.event === "operator_answer")).toBe(false);

    const delivered = await manager.deliverAnswer(
      started.runId,
      "clarify",
      badAnswer,
    );
    expect(delivered.ok).toBe(false);
    if (!delivered.ok) expect(delivered.status).toBe(400);

    const after = await store.listStageEvents(started.runId, "clarify");
    expect(after.some((e) => e.event === "operator_answer")).toBe(false);
    expect(after.some((e) => e.event === "resumed")).toBe(false);
    expect(after.map((e) => e.event)).toEqual(before.map((e) => e.event));
  });

  it("AE1: after wait-enter, reopened store still derives pending prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-qa-ae1-"));
    const store = createRunStore({ rootDir: root });
    const { prompt } = await loadPair("confirm.json");
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [prompt],
        envelope: successEnvelope,
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

    const store2 = createRunStore({ rootDir: root });
    const detail = await store2.readRun(started.runId);
    const stage = detail.stages.find((s) => s.stage_id === "clarify")!;
    expect(stage.status).toBe("waiting_for_input");
    expect(stage.pending_prompt).toEqual(prompt);
    expect(stage.events.some((e) => e.event === "operator_answer")).toBe(false);
    const promptIdx = stage.events.findIndex((e) => e.event === "operator_prompt");
    const waitIdx = stage.events.findIndex((e) => e.event === "waiting_for_input");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeGreaterThan(promptIdx);
  });
});
