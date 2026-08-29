import { describe, expect, it, vi } from "vitest";
import { canRetry } from "./eligibility";
import { createStageRetrySession } from "./useStageRetry";

describe("canRetry eligibility", () => {
  it("returns true only for failed", () => {
    expect(canRetry("failed")).toBe(true);
  });

  it("returns false for non-failed statuses", () => {
    expect(canRetry("waiting_for_input")).toBe(false);
    expect(canRetry("running")).toBe(false);
    expect(canRetry("succeeded")).toBe(false);
    expect(canRetry("pending")).toBe(false);
    expect(canRetry("skipped")).toBe(false);
  });
});

describe("createStageRetrySession", () => {
  it("calls retry and onSuccess on success", async () => {
    const retry = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const session = createStageRetrySession({ retry, onSuccess });

    await session.retry("stage-b");

    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith("stage-b");
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(session.getState().retryingStageIds.size).toBe(0);
    expect(session.getState().error).toBeNull();
  });

  it("sets error and clears retrying on failure", async () => {
    const retry = vi.fn(async () => {
      throw new Error("stage not failed");
    });
    const onSuccess = vi.fn();
    const session = createStageRetrySession({ retry, onSuccess });

    await session.retry("stage-b");

    expect(onSuccess).not.toHaveBeenCalled();
    expect(session.getState().retryingStageIds.size).toBe(0);
    expect(session.getState().error).toBe("stage not failed");
  });

  it("allows parallel retry on different stages", async () => {
    let resolveB: (() => void) | undefined;
    let resolveC: (() => void) | undefined;
    const retry = vi.fn((stageId: string) => {
      if (stageId === "stage-b") {
        return new Promise<void>((resolve) => {
          resolveB = resolve;
        });
      }
      if (stageId === "stage-c") {
        return new Promise<void>((resolve) => {
          resolveC = resolve;
        });
      }
      return Promise.resolve();
    });
    const onSuccess = vi.fn();
    const session = createStageRetrySession({ retry, onSuccess });

    const first = session.retry("stage-b");
    const second = session.retry("stage-c");

    expect(session.getState().retryingStageIds.has("stage-b")).toBe(true);
    expect(session.getState().retryingStageIds.has("stage-c")).toBe(true);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledWith("stage-b");
    expect(retry).toHaveBeenCalledWith("stage-c");

    resolveB?.();
    await first;
    resolveC?.();
    await second;

    expect(session.getState().retryingStageIds.size).toBe(0);
  });

  it("ignores duplicate retry on same stage while in flight", async () => {
    let resolveFirst: (() => void) | undefined;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const onSuccess = vi.fn();
    const session = createStageRetrySession({ retry, onSuccess });

    const first = session.retry("stage-a");
    const second = session.retry("stage-a");
    expect(session.getState().retryingStageIds.has("stage-a")).toBe(true);

    resolveFirst?.();
    await first;
    await second;

    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith("stage-a");
  });

  it("in-flight retry of author-diagrams~1 does not block author-diagrams~2", async () => {
    let resolveOne: (() => void) | undefined;
    let resolveTwo: (() => void) | undefined;
    const retry = vi.fn((stageId: string) => {
      if (stageId === "author-diagrams~1") {
        return new Promise<void>((resolve) => {
          resolveOne = resolve;
        });
      }
      if (stageId === "author-diagrams~2") {
        return new Promise<void>((resolve) => {
          resolveTwo = resolve;
        });
      }
      return Promise.resolve();
    });
    const onSuccess = vi.fn();
    const session = createStageRetrySession({ retry, onSuccess });

    const first = session.retry("author-diagrams~1");
    const second = session.retry("author-diagrams~2");

    expect(session.getState().retryingStageIds.has("author-diagrams~1")).toBe(true);
    expect(session.getState().retryingStageIds.has("author-diagrams~2")).toBe(true);
    expect(retry).toHaveBeenCalledTimes(2);

    resolveOne?.();
    await first;
    resolveTwo?.();
    await second;
  });

  it("ignores duplicate retry on author-diagrams~1 while in flight", async () => {
    let resolveFirst: (() => void) | undefined;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const onSuccess = vi.fn();
    const session = createStageRetrySession({ retry, onSuccess });

    const first = session.retry("author-diagrams~1");
    const second = session.retry("author-diagrams~1");
    expect(session.getState().retryingStageIds.has("author-diagrams~1")).toBe(true);

    resolveFirst?.();
    await first;
    await second;

    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith("author-diagrams~1");
  });
});
