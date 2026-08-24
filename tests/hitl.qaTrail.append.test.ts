import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendOperatorAnswer,
  appendOperatorPrompt,
  derivePendingPrompt,
} from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  normalizePromptIds,
  parseAskOperatorAnswer,
  parseAskOperatorParams,
  type AskOperatorAnswer,
  type AskOperatorPrompt,
} from "../src/tools/askOperator.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "askOperator",
);

async function loadPair(name: string): Promise<{
  prompt: AskOperatorPrompt;
  answer: AskOperatorAnswer;
}> {
  const raw = await readFile(path.join(fixtureDir, name), "utf8");
  const fixture = JSON.parse(raw) as { prompt: unknown; answer: unknown };
  return {
    prompt: normalizePromptIds(parseAskOperatorParams(fixture.prompt)),
    answer: parseAskOperatorAnswer(fixture.answer),
  };
}

describe("qaTrail append helpers", () => {
  it("AE2: answer append leaves prior prompt line byte-identical", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-qa-append-"));
    const store = createRunStore({ rootDir: root });
    const { prompt, answer } = await loadPair("free_text.json");
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: sample\n",
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");

    await appendOperatorPrompt(store, run.runId, "clarify", prompt);
    const eventsBefore = await store.listStageEvents(run.runId, "clarify");
    const promptBefore = eventsBefore.find((e) => e.event === "operator_prompt");
    expect(promptBefore).toBeDefined();

    await appendOperatorAnswer(store, run.runId, "clarify", answer);

    const events = await store.listStageEvents(run.runId, "clarify");
    expect(events.find((e) => e.event === "operator_prompt")).toEqual(promptBefore);
    expect(events.map((e) => e.event)).toEqual([
      "operator_prompt",
      "operator_answer",
    ]);
    expect(events[0]).toMatchObject({ event: "operator_prompt", prompt });
    expect(events[1]).toMatchObject({
      event: "operator_answer",
      promptId: answer.promptId,
      answer,
    });
  });

  it("AE1: prompt survives store reopen while waiting (no answer)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-qa-crash-"));
    const store = createRunStore({ rootDir: root });
    const { prompt } = await loadPair("confirm.json");
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: sample\n",
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await appendOperatorPrompt(store, run.runId, "clarify", prompt);
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const store2 = createRunStore({ rootDir: root });
    const events = await store2.listStageEvents(run.runId, "clarify");
    expect(events.map((e) => e.event)).toEqual([
      "started",
      "operator_prompt",
      "waiting_for_input",
    ]);
    expect(events[1]).toMatchObject({ event: "operator_prompt", prompt });
    expect(events.some((e) => e.event === "operator_answer")).toBe(false);
    expect(derivePendingPrompt(events)).toEqual(prompt);

    const detail = await store2.readRun(run.runId);
    expect(detail.stages[0]?.pending_prompt).toEqual(prompt);
  });
});
