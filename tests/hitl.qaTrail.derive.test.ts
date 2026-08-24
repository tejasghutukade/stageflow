import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendOperatorAnswer,
  appendOperatorPrompt,
  derivePendingPrompt,
  listQaExchanges,
  operatorAnswerEvent,
  operatorPromptEvent,
  QaTrailInvariantError,
} from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { StageLogEvent } from "../src/runstore/port.js";
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

describe("qaTrail derivePendingPrompt / listQaExchanges", () => {
  it("AE3: two completed exchanges + one pending; stage-scoped", async () => {
    const free = await loadPair("free_text.json");
    const confirm = await loadPair("confirm.json");
    const multi = await loadPair("multi_question.json");

    const events: StageLogEvent[] = [
      { event: "started" },
      operatorPromptEvent(free.prompt),
      { event: "waiting_for_input" },
      operatorAnswerEvent(free.answer),
      { event: "resumed" },
      operatorPromptEvent(confirm.prompt),
      { event: "waiting_for_input" },
      operatorAnswerEvent(confirm.answer),
      { event: "resumed" },
      operatorPromptEvent(multi.prompt),
      { event: "waiting_for_input" },
    ];

    const exchanges = listQaExchanges(events);
    expect(exchanges).toHaveLength(3);
    expect(exchanges[0]).toEqual({ prompt: free.prompt, answer: free.answer });
    expect(exchanges[1]).toEqual({
      prompt: confirm.prompt,
      answer: confirm.answer,
    });
    expect(exchanges[2]).toEqual({ prompt: multi.prompt, answer: null });
    expect(derivePendingPrompt(events)).toEqual(multi.prompt);

    const root = await mkdtemp(path.join(tmpdir(), "sf-qa-ae3-scope-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: sample\n",
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.ensureStageWorkspace(run.runId, "other");
    for (const ev of events) {
      await store.appendStageEvent(run.runId, "clarify", ev);
    }
    await appendOperatorPrompt(store, run.runId, "other", free.prompt);

    const clarifyEvents = await store.listStageEvents(run.runId, "clarify");
    expect(listQaExchanges(clarifyEvents)).toHaveLength(3);
    expect(clarifyEvents.map((e) => e.event).filter((e) => e.startsWith("operator_"))).toEqual([
      "operator_prompt",
      "operator_answer",
      "operator_prompt",
      "operator_answer",
      "operator_prompt",
    ]);

    const otherEvents = await store.listStageEvents(run.runId, "other");
    expect(otherEvents.map((e) => e.event)).toEqual(["operator_prompt"]);
    expect(listQaExchanges(otherEvents)).toEqual([
      { prompt: free.prompt, answer: null },
    ]);
  });

  it("pending clears after answer; snapshot omits pending_prompt", async () => {
    const { prompt, answer } = await loadPair("free_text.json");
    const root = await mkdtemp(path.join(tmpdir(), "sf-qa-derive-"));
    const store = createRunStore({ rootDir: root });
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

    const pendingDetail = await store.readRun(run.runId);
    expect(pendingDetail.stages[0]?.pending_prompt).toEqual(prompt);
    expect(derivePendingPrompt(pendingDetail.stages[0]!.events)).toEqual(prompt);

    await appendOperatorAnswer(store, run.runId, "clarify", answer);
    await store.appendStageEvent(run.runId, "clarify", { event: "resumed" });

    const cleared = await store.readRun(run.runId);
    expect(cleared.stages[0]?.pending_prompt).toBeUndefined();
    expect(derivePendingPrompt(cleared.stages[0]!.events)).toBeNull();
    expect(listQaExchanges(cleared.stages[0]!.events)).toEqual([
      { prompt, answer },
    ]);
  });

  it("sqlite readRun also projects pending_prompt", async () => {
    const { prompt, answer } = await loadPair("confirm.json");
    const root = await mkdtemp(path.join(tmpdir(), "sf-qa-sqlite-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: sample\n",
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await appendOperatorPrompt(store, run.runId, "clarify", prompt);

    const pending = await store.readRun(run.runId);
    expect(pending.stages[0]?.pending_prompt).toEqual(prompt);

    await appendOperatorAnswer(store, run.runId, "clarify", answer);
    const cleared = await store.readRun(run.runId);
    expect(cleared.stages[0]?.pending_prompt).toBeUndefined();
  });

  it("ignores interleaved tool/message/lifecycle activity", async () => {
    const { prompt, answer } = await loadPair("free_text.json");
    const events: StageLogEvent[] = [
      { event: "started" },
      { event: "agent_start" },
      { event: "tool_start", toolName: "ask_operator" },
      operatorPromptEvent(prompt),
      { event: "message", role: "assistant", text: "waiting…" },
      { event: "waiting_for_input" },
      { event: "tool_end", toolName: "ask_operator" },
      operatorAnswerEvent(answer),
      { event: "resumed" },
      { event: "message", role: "user", text: "ok" },
    ];

    expect(listQaExchanges(events)).toEqual([{ prompt, answer }]);
    expect(derivePendingPrompt(events)).toBeNull();
  });

  it("R8: two unmatched prompts throw QaTrailInvariantError", async () => {
    const a = await loadPair("free_text.json");
    const b = await loadPair("confirm.json");
    const events: StageLogEvent[] = [
      operatorPromptEvent(a.prompt),
      operatorPromptEvent(b.prompt),
    ];

    expect(() => listQaExchanges(events)).toThrow(QaTrailInvariantError);
    expect(() => derivePendingPrompt(events)).toThrow(QaTrailInvariantError);
    try {
      derivePendingPrompt(events);
    } catch (err) {
      expect(err).toBeInstanceOf(QaTrailInvariantError);
      expect((err as QaTrailInvariantError).code).toBe(
        "R8_MULTIPLE_PENDING_PROMPTS",
      );
    }
  });

  it("AE4: multi_question and artifact_backed fixtures survive derive round-trip", async () => {
    for (const name of ["multi_question.json", "artifact_backed.json"] as const) {
      const { prompt, answer } = await loadPair(name);
      const pendingEvents: StageLogEvent[] = [operatorPromptEvent(prompt)];
      expect(derivePendingPrompt(pendingEvents)).toEqual(prompt);
      expect(listQaExchanges(pendingEvents)).toEqual([
        { prompt, answer: null },
      ]);

      const completed: StageLogEvent[] = [
        operatorPromptEvent(prompt),
        operatorAnswerEvent(answer),
      ];
      expect(derivePendingPrompt(completed)).toBeNull();
      expect(listQaExchanges(completed)).toEqual([{ prompt, answer }]);
    }
  });

  it("AE5: StageSnapshot.events carry Q&A chronologically for Activity labels", async () => {
    const { prompt, answer } = await loadPair("free_text.json");
    const root = await mkdtemp(path.join(tmpdir(), "sf-qa-ae5-"));
    const store = createRunStore({ rootDir: root });
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
    await appendOperatorAnswer(store, run.runId, "clarify", answer);
    await store.appendStageEvent(run.runId, "clarify", { event: "resumed" });

    const detail = await store.readRun(run.runId);
    const stage = detail.stages[0]!;
    expect(stage.events.map((e) => e.event)).toEqual([
      "started",
      "operator_prompt",
      "waiting_for_input",
      "operator_answer",
      "resumed",
    ]);
    expect(stage.pending_prompt).toBeUndefined();
    expect(listQaExchanges(stage.events)).toEqual([{ prompt, answer }]);

    const { formatActivityLabel } = await import("../ui/src/status/activityCopy.js");
    expect(formatActivityLabel({ event: "operator_prompt" })).toBe(
      "Operator prompt",
    );
    expect(formatActivityLabel({ event: "operator_answer" })).toBe(
      "Operator answer",
    );
    expect(formatActivityLabel({ event: "started" })).toBe("Stage started");
  });
});
