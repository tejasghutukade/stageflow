import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMIT_REMINDERS,
  emitReminderPrompt,
  lastTurnProviderError,
  remindUntilEmitted,
  type StageTurnSession,
} from "../src/agent/stageTurnDriver.js";
import type { EmitCapture } from "../src/tools/emitStageEnvelope.js";

const ok = { role: "assistant", stopReason: "stop" };
const envelope = { status: "success" as const, summary: "done", artifacts: [] };

/** Each reminder runs the next scripted turn: it may push messages and touch the capture. */
function fakeSession(
  capture: EmitCapture,
  turns: Array<(messages: unknown[], capture: EmitCapture) => void>,
  initial: unknown[] = [ok],
) {
  const messages: unknown[] = [...initial];
  const prompts: string[] = [];
  const session: StageTurnSession = {
    get messages() {
      return messages;
    },
    async prompt(text: string) {
      prompts.push(text);
      messages.push({ role: "user", content: text });
      const turn = turns.shift();
      if (turn) turn(messages, capture);
      else messages.push(ok);
    },
  };
  return { session, prompts };
}

const opts = { emitToolName: "emit_stage_envelope", shouldStop: () => false };

describe("remindUntilEmitted", () => {
  it("does nothing when the first turn already emitted", async () => {
    const capture: EmitCapture = { envelope };
    const { session, prompts } = fakeSession(capture, []);
    expect(await remindUntilEmitted(session, capture, opts)).toEqual({ reminders: 0 });
    expect(prompts).toEqual([]);
  });

  it("nudges once when the agent stops without emitting, then stops after the emit", async () => {
    const capture: EmitCapture = {};
    const { session, prompts } = fakeSession(capture, [
      (messages, c) => {
        c.envelope = envelope;
        messages.push(ok);
      },
    ]);
    expect(await remindUntilEmitted(session, capture, opts)).toEqual({ reminders: 1 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`Reminder 1 of ${DEFAULT_EMIT_REMINDERS}`);
    expect(prompts[0]).toContain("call emit_stage_envelope");
  });

  it("gives up after the reminder budget and leaves the capture empty", async () => {
    const capture: EmitCapture = {};
    const { session, prompts } = fakeSession(capture, []);
    expect(await remindUntilEmitted(session, capture, { ...opts, maxReminders: 3 })).toEqual({ reminders: 3 });
    expect(prompts).toHaveLength(3);
    expect(capture.envelope).toBeUndefined();
  });

  it("quotes the rejected emit so the agent can fix it", async () => {
    const capture: EmitCapture = { error: "payload.count must be integer" };
    const { session, prompts } = fakeSession(capture, [
      (messages, c) => {
        c.envelope = envelope;
        messages.push(ok);
      },
    ]);
    await remindUntilEmitted(session, capture, opts);
    expect(prompts[0]).toContain("was rejected: payload.count must be integer");
  });

  it("never nudges after a provider error and reports it", async () => {
    const capture: EmitCapture = {};
    const { session, prompts } = fakeSession(capture, [], [
      { role: "assistant", stopReason: "error", errorMessage: "Cursor SDK runs require a Cursor SDK API key." },
    ]);
    expect(await remindUntilEmitted(session, capture, opts)).toEqual({
      reminders: 0,
      providerError: "Cursor SDK runs require a Cursor SDK API key.",
    });
    expect(prompts).toEqual([]);
  });

  it("stops nudging when a reminder turn itself hits a provider error", async () => {
    const capture: EmitCapture = {};
    const { session, prompts } = fakeSession(capture, [
      (messages) => {
        messages.push({ role: "assistant", stopReason: "error", errorMessage: "429 rate limited" });
      },
    ]);
    expect(await remindUntilEmitted(session, capture, opts)).toEqual({
      reminders: 1,
      providerError: "429 rate limited",
    });
    expect(prompts).toHaveLength(1);
  });

  it("does not nudge an aborted turn or a stopping stage", async () => {
    const capture: EmitCapture = {};
    const aborted = fakeSession(capture, [], [{ role: "assistant", stopReason: "aborted" }]);
    expect(await remindUntilEmitted(aborted.session, capture, opts)).toEqual({ reminders: 0 });
    expect(aborted.prompts).toEqual([]);

    const closing = fakeSession(capture, []);
    expect(await remindUntilEmitted(closing.session, capture, { ...opts, shouldStop: () => true })).toEqual({
      reminders: 0,
    });
    expect(closing.prompts).toEqual([]);
  });

  it("stops between reminders once the stage starts closing", async () => {
    const capture: EmitCapture = {};
    let stopping = false;
    const { session, prompts } = fakeSession(capture, [
      (messages) => {
        stopping = true;
        messages.push(ok);
      },
    ]);
    expect(await remindUntilEmitted(session, capture, { ...opts, shouldStop: () => stopping })).toEqual({
      reminders: 1,
    });
    expect(prompts).toHaveLength(1);
  });
});

describe("lastTurnProviderError", () => {
  it("reads only the latest assistant turn", () => {
    expect(
      lastTurnProviderError([
        { role: "assistant", stopReason: "error", errorMessage: "old" },
        { role: "user", content: "retry" },
        ok,
      ]),
    ).toBeUndefined();
    expect(lastTurnProviderError([ok, { role: "toolResult" }, { role: "assistant", stopReason: "error" }])).toBe(
      "the model provider returned an error",
    );
  });

  it("truncates long provider errors", () => {
    const text = lastTurnProviderError([{ role: "assistant", stopReason: "error", errorMessage: "x".repeat(900) }]);
    expect(text).toHaveLength(501);
    expect(text?.endsWith("…")).toBe(true);
  });
});

describe("emitReminderPrompt", () => {
  it("always offers a failure emit instead of ending the turn", () => {
    const text = emitReminderPrompt("emit_stage_envelope", 2, 2);
    expect(text).toContain("Reminder 2 of 2");
    expect(text).toContain('status "failure"');
    expect(text).toContain("Do not end your turn without calling it.");
  });
});
