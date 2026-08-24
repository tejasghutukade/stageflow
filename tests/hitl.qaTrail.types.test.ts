import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT_LIMIT,
  truncateActivityText,
  type StageActivityEvent,
  type StageLogLine,
} from "../src/agent/activity.js";
import {
  isOperatorAnswerEvent,
  isOperatorPromptEvent,
  operatorAnswerEvent,
  operatorPromptEvent,
} from "../src/hitl/qaTrail.js";
import { stageStatusFromEvents } from "../src/runstore/port.js";
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

describe("qaTrail activity event vocabulary", () => {
  it.each([
    "free_text.json",
    "confirm.json",
    "multi_question.json",
    "artifact_backed.json",
  ] as const)("constructs operator_prompt/answer from %s", async (name) => {
    const { prompt, answer } = await loadPair(name);
    const promptEvent = operatorPromptEvent(prompt);
    const answerEvent = operatorAnswerEvent(answer);

    expect(promptEvent).toEqual({ event: "operator_prompt", prompt });
    expect(answerEvent).toEqual({
      event: "operator_answer",
      promptId: answer.promptId,
      answer,
    });
    expect(isOperatorPromptEvent(promptEvent)).toBe(true);
    expect(isOperatorAnswerEvent(answerEvent)).toBe(true);
    expect(isOperatorPromptEvent(answerEvent)).toBe(false);
    expect(isOperatorAnswerEvent(promptEvent)).toBe(false);

    const asActivity: StageActivityEvent[] = [promptEvent, answerEvent];
    const asLog: StageLogLine[] = [promptEvent, answerEvent];
    expect(asActivity.map((e) => e.event)).toEqual([
      "operator_prompt",
      "operator_answer",
    ]);
    expect(asLog.map((e) => e.event)).toEqual([
      "operator_prompt",
      "operator_answer",
    ]);
  });

  it("stageStatusFromEvents ignores Q&A events", async () => {
    const { prompt, answer } = await loadPair("free_text.json");
    const promptEvent = operatorPromptEvent(prompt);
    const answerEvent = operatorAnswerEvent(answer);

    expect(
      stageStatusFromEvents([
        { event: "started" },
        promptEvent,
      ]),
    ).toBe("running");

    expect(
      stageStatusFromEvents([
        { event: "started" },
        promptEvent,
        { event: "waiting_for_input" },
      ]),
    ).toBe("waiting_for_input");

    expect(
      stageStatusFromEvents([promptEvent, answerEvent]),
    ).toBe("pending");

    expect(
      stageStatusFromEvents([
        { event: "started" },
        promptEvent,
        { event: "waiting_for_input" },
        answerEvent,
        { event: "resumed" },
      ]),
    ).toBe("running");
  });

  it("regression: non-HITL started/succeeded/failed status unchanged", () => {
    expect(stageStatusFromEvents([{ event: "started" }])).toBe("running");
    expect(
      stageStatusFromEvents([{ event: "started" }, { event: "succeeded" }]),
    ).toBe("succeeded");
    expect(
      stageStatusFromEvents([
        { event: "started" },
        { event: "failed", reason: "boom" },
      ]),
    ).toBe("failed");
  });

  it("large message and many artifacts round-trip without ACTIVITY_TEXT_LIMIT", () => {
    const longMessage = "m".repeat(ACTIVITY_TEXT_LIMIT + 200);
    const artifacts = Array.from(
      { length: 40 },
      (_, i) => `stages/plan/attempts/1/artifacts/file-${i}-${"p".repeat(30)}.md`,
    );
    const prompt: AskOperatorPrompt = {
      kind: "artifact_backed",
      id: "large-prompt",
      message: longMessage,
      artifacts,
    };
    const answer: AskOperatorAnswer = {
      promptId: "large-prompt",
      kind: "artifact_backed",
      decision: "accept",
      text: "t".repeat(ACTIVITY_TEXT_LIMIT + 100),
    };

    const promptEvent = operatorPromptEvent(prompt);
    const answerEvent = operatorAnswerEvent(answer);

    expect(truncateActivityText(longMessage)?.length).toBe(
      ACTIVITY_TEXT_LIMIT + 1,
    );
    expect(promptEvent.prompt.message.length).toBe(longMessage.length);
    expect(promptEvent.prompt.kind === "artifact_backed").toBe(true);
    if (promptEvent.prompt.kind === "artifact_backed") {
      expect(promptEvent.prompt.artifacts).toEqual(artifacts);
    }
    expect(answerEvent.answer.kind === "artifact_backed").toBe(true);
    if (answerEvent.answer.kind === "artifact_backed") {
      expect(answerEvent.answer.text?.length).toBe(answer.text!.length);
    }

    const roundTripped = JSON.parse(
      JSON.stringify([promptEvent, answerEvent]),
    ) as StageActivityEvent[];
    expect(roundTripped).toEqual([promptEvent, answerEvent]);
  });
});
