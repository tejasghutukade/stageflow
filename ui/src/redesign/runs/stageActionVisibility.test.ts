import { describe, expect, it } from "vitest";
import { stageActionVisibility } from "./stageActionVisibility";

const wired = {
  hasRetry: true,
  hasResume: true,
  hasAbandon: true,
};

describe("stageActionVisibility", () => {
  it("shows an enabled retry for a failed stage when the gate is clear", () => {
    expect(
      stageActionVisibility({
        status: "failed",
        events: [{ event: "failed", reason: "missing emit_stage_envelope" }],
        retryBlocked: false,
        ...wired,
      }),
    ).toEqual({
      showRetry: true,
      showResume: false,
      showAbandon: false,
      retryDisabled: false,
    });
  });

  it("shows a disabled retry when an answer gate is open, including stages that are not failed", () => {
    expect(
      stageActionVisibility({
        status: "waiting_for_input",
        events: [],
        retryBlocked: true,
        ...wired,
      }),
    ).toEqual({
      showRetry: true,
      showResume: false,
      showAbandon: false,
      retryDisabled: true,
    });
    expect(
      stageActionVisibility({
        status: "failed",
        events: [{ event: "failed", reason: "boom" }],
        retryBlocked: true,
        ...wired,
      }),
    ).toMatchObject({ showRetry: true, retryDisabled: true });
  });

  it("hides retry when the stage cannot retry and no gate is blocking it", () => {
    expect(
      stageActionVisibility({
        status: "succeeded",
        events: [],
        retryBlocked: false,
        ...wired,
      }).showRetry,
    ).toBe(false);
  });

  it("hides retry when no retry handler is wired", () => {
    expect(
      stageActionVisibility({
        status: "failed",
        events: [],
        retryBlocked: true,
        hasRetry: false,
        hasResume: false,
        hasAbandon: false,
      }),
    ).toEqual({
      showRetry: false,
      showResume: false,
      showAbandon: false,
      retryDisabled: true,
    });
  });

  it("shows resume for interrupted stages and timeout failures", () => {
    expect(
      stageActionVisibility({
        status: "interrupted",
        events: [{ event: "interrupted", reason: "host_shutdown" }],
        retryBlocked: false,
        ...wired,
      }),
    ).toMatchObject({ showResume: true, showRetry: false, showAbandon: false });
    expect(
      stageActionVisibility({
        status: "failed",
        events: [{ event: "failed", reason: "stage timed out after 3600000ms" }],
        retryBlocked: false,
        ...wired,
      }),
    ).toMatchObject({ showResume: true, showRetry: true, retryDisabled: false });
    expect(
      stageActionVisibility({
        status: "failed",
        events: [{ event: "failed", reason: "missing emit_stage_envelope" }],
        retryBlocked: false,
        hasRetry: false,
        hasResume: true,
        hasAbandon: false,
      }).showResume,
    ).toBe(false);
  });

  it("shows abandon only for a running stage with a handler", () => {
    expect(
      stageActionVisibility({
        status: "running",
        events: [],
        retryBlocked: false,
        ...wired,
      }),
    ).toMatchObject({ showAbandon: true, showRetry: false, showResume: false });
    expect(
      stageActionVisibility({
        status: "running",
        events: [],
        retryBlocked: false,
        hasRetry: true,
        hasResume: true,
        hasAbandon: false,
      }).showAbandon,
    ).toBe(false);
  });

  it("keeps resume visible while a gate disables retry", () => {
    expect(
      stageActionVisibility({
        status: "interrupted",
        events: [],
        retryBlocked: true,
        ...wired,
      }),
    ).toEqual({
      showRetry: true,
      showResume: true,
      showAbandon: false,
      retryDisabled: true,
    });
  });
});
