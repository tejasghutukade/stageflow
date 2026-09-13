import { describe, expect, it } from "vitest";
import { assertRequiredEnvelope } from "../src/envelope/check.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { FeedbackLoopConfig } from "../src/types/pipeline.js";

const context: FeedbackLoopConfig = {
  target: "implement",
  max_replays: 2,
  on_max_replays: "require_continue",
  replay_session: "resume",
};

function envelope(feedback_loop?: unknown) {
  return {
    status: "success",
    summary: "Review complete",
    artifacts: [],
    ...(feedback_loop === undefined ? {} : { feedback_loop }),
  };
}

describe("feedback_loop envelope contract", () => {
  it("parses the two supported action shapes", () => {
    expect(assertRequiredEnvelope(envelope({ action: "continue" })).feedback_loop).toEqual({
      action: "continue",
    });
    expect(assertRequiredEnvelope(envelope({ action: "send_back", target: "implement" })).feedback_loop).toEqual({
      action: "send_back",
      target: "implement",
    });
  });

  it("requires an action for a successful configured source", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    );
    const result = await tool.execute("emit", envelope());
    expect(result.isError).toBe(true);
    expect(result.details.error).toMatch(/action is required/i);
  });

  it("accepts continue and the allowed send_back target", async () => {
    const continueCapture = {};
    const continueTool = createEmitStageEnvelopeTool(
      continueCapture,
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    );
    expect(await continueTool.execute("continue", envelope({ action: "continue" }))).toMatchObject({
      terminate: true,
    });
    expect(continueCapture.envelope?.feedback_loop).toEqual({ action: "continue" });

    const sendBackCapture = {};
    const sendBackTool = createEmitStageEnvelopeTool(
      sendBackCapture,
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    );
    expect(
      await sendBackTool.execute("send-back", envelope({ action: "send_back", target: "implement" })),
    ).toMatchObject({ terminate: true });
  });

  it("rejects feedback-loop actions from non-sources and unknown targets", async () => {
    const ordinary = createEmitStageEnvelopeTool({});
    expect(
      await ordinary.execute("ordinary", envelope({ action: "continue" })),
    ).toMatchObject({ isError: true });

    const source = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    );
    expect(
      await source.execute("unknown", envelope({ action: "send_back", target: "deploy" })),
    ).toMatchObject({ isError: true });
  });

  it("rejects malformed actions and a feedback action on failure", async () => {
    expect(() => assertRequiredEnvelope(envelope({ action: "continue", target: "plan" }))).toThrow(
      /not allowed/i,
    );
    expect(() => assertRequiredEnvelope(envelope({ action: "send_back" }))).toThrow(
      /target must be a non-empty string/i,
    );
    expect(() =>
      assertRequiredEnvelope(envelope({ action: "continue", unexpected: true })),
    ).toThrow(/unknown key "unexpected"/i);
    expect(() =>
      assertRequiredEnvelope(
        envelope({ action: "send_back", target: "plan", unexpected: true }),
      ),
    ).toThrow(/unknown key "unexpected"/i);

    const tool = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    );
    expect(
      await tool.execute("failure", {
        ...envelope({ action: "continue" }),
        status: "failure",
      }),
    ).toMatchObject({ isError: true });
  });

  it("allows send_back to bypass fork routing but requires routing on continue", async () => {
    const forkSource = createEmitStageEnvelopeTool(
      {},
      undefined,
      { immediateSuccessorIds: ["next"], forkShape: { cardinality: "one", allowNone: false } },
      undefined,
      undefined,
      context,
    );
    expect(
      await forkSource.execute("fork-send-back", {
        ...envelope({ action: "send_back", target: "implement" }),
      }),
    ).toMatchObject({ terminate: true });

    const forkContinue = createEmitStageEnvelopeTool(
      {},
      undefined,
      { immediateSuccessorIds: ["next"], forkShape: { cardinality: "one", allowNone: false } },
      undefined,
      undefined,
      context,
    );
    expect(
      await forkContinue.execute("fork-continue", envelope({ action: "continue" })),
    ).toMatchObject({ isError: true });
  });

  it("rejects send_back combined with fork routing", async () => {
    const forkSource = createEmitStageEnvelopeTool(
      {},
      undefined,
      { immediateSuccessorIds: ["next"], forkShape: { cardinality: "one", allowNone: false } },
      undefined,
      undefined,
      context,
    );
    expect(
      await forkSource.execute("fork-send-back", {
        ...envelope({ action: "send_back", target: "implement" }),
        fork_choice: ["next"],
      }),
    ).toMatchObject({ isError: true });
  });

});
