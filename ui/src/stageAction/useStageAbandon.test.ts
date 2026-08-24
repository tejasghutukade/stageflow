import { describe, expect, it, vi } from "vitest";
import { canAbandon, isStageActionBusy } from "./eligibility";
import {
  ABANDON_CONFIRM_MESSAGE,
  createStageAbandonSession,
} from "./useStageAbandon";

describe("canAbandon eligibility", () => {
  it("returns true only for running", () => {
    expect(canAbandon("running")).toBe(true);
  });

  it("returns false for non-running statuses", () => {
    expect(canAbandon("waiting_for_input")).toBe(false);
    expect(canAbandon("failed")).toBe(false);
    expect(canAbandon("succeeded")).toBe(false);
    expect(canAbandon("pending")).toBe(false);
  });
});

describe("isStageActionBusy", () => {
  it("is true when retrying or abandoning the stage", () => {
    expect(
      isStageActionBusy(
        { retryingStageIds: new Set(["stage-a"]), abandoningStageId: null },
        "stage-a",
      ),
    ).toBe(true);
    expect(
      isStageActionBusy(
        { retryingStageIds: new Set(), abandoningStageId: "stage-b" },
        "stage-b",
      ),
    ).toBe(true);
    expect(
      isStageActionBusy(
        { retryingStageIds: new Set(["stage-a"]), abandoningStageId: "stage-b" },
        "stage-c",
      ),
    ).toBe(false);
  });
});

describe("createStageAbandonSession", () => {
  it("calls abandon and onSuccess when confirmed", async () => {
    const abandon = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const confirm = vi.fn(() => true);
    const session = createStageAbandonSession({ abandon, onSuccess, confirm });

    await session.abandon("stage-b");

    expect(confirm).toHaveBeenCalledWith("stage-b");
    expect(abandon).toHaveBeenCalledOnce();
    expect(abandon).toHaveBeenCalledWith("stage-b");
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(session.getState()).toEqual({ abandoningStageId: null, error: null });
  });

  it("does nothing when confirm is declined", async () => {
    const abandon = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const confirm = vi.fn(() => false);
    const session = createStageAbandonSession({ abandon, onSuccess, confirm });

    await session.abandon("stage-b");

    expect(abandon).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(session.getState()).toEqual({ abandoningStageId: null, error: null });
  });

  it("sets error and clears abandoning on failure", async () => {
    const abandon = vi.fn(async () => {
      throw new Error("stage not running");
    });
    const onSuccess = vi.fn();
    const confirm = vi.fn(() => true);
    const session = createStageAbandonSession({ abandon, onSuccess, confirm });

    await session.abandon("stage-b");

    expect(onSuccess).not.toHaveBeenCalled();
    expect(session.getState()).toEqual({
      abandoningStageId: null,
      error: "stage not running",
    });
  });

  it("ignores a second abandon while one is in flight", async () => {
    let resolveFirst: (() => void) | undefined;
    const abandon = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const onSuccess = vi.fn();
    const confirm = vi.fn(() => true);
    const session = createStageAbandonSession({ abandon, onSuccess, confirm });

    const first = session.abandon("stage-a");
    const second = session.abandon("stage-b");
    expect(session.getState().abandoningStageId).toBe("stage-a");

    resolveFirst?.();
    await first;
    await second;

    expect(abandon).toHaveBeenCalledOnce();
    expect(abandon).toHaveBeenCalledWith("stage-a");
  });
});

describe("ABANDON_CONFIRM_MESSAGE", () => {
  it("mentions failed status and retry", () => {
    expect(ABANDON_CONFIRM_MESSAGE).toMatch(/failed/i);
    expect(ABANDON_CONFIRM_MESSAGE).toMatch(/retry/i);
  });
});
