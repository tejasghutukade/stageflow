import { describe, expect, it, vi } from "vitest";
import { cancelledDisplayCopy, statusCopy } from "../status/runStatus";
import {
  canCancelRun,
  canDeleteRun,
  createRunCancelSession,
  createRunDeleteSession,
  typedDeleteConfirm,
} from "./runActions";

describe("canCancelRun", () => {
  it("allows created, queued, and running", () => {
    expect(canCancelRun("created")).toBe(true);
    expect(canCancelRun("queued")).toBe(true);
    expect(canCancelRun("running")).toBe(true);
  });

  it("rejects terminal statuses", () => {
    expect(canCancelRun("succeeded")).toBe(false);
    expect(canCancelRun("failed")).toBe(false);
    expect(canCancelRun("cancelled")).toBe(false);
  });
});

describe("canDeleteRun", () => {
  it("allows every known run status", () => {
    for (const status of [
      "created",
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const) {
      expect(canDeleteRun(status)).toBe(true);
    }
  });
});

describe("cancelled status copy", () => {
  it("reflects cancelled via runStatus without a default fallthrough", () => {
    expect(statusCopy("cancelled")).toBe("cancelled");
    expect(cancelledDisplayCopy("operator stop")).toBe("cancelled: operator stop");
    expect(cancelledDisplayCopy()).toBe("cancelled");
  });
});

describe("createRunCancelSession", () => {
  it("calls cancel and onSuccess when a reason is provided", async () => {
    const cancel = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const session = createRunCancelSession({
      cancel,
      onSuccess,
      promptReason: () => "stop please",
    });

    await session.cancel();

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("stop please");
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(session.getState()).toEqual({ cancelling: false, error: null });
  });

  it("does not call cancel when the reason prompt is cancelled", async () => {
    const cancel = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const session = createRunCancelSession({
      cancel,
      onSuccess,
      promptReason: () => null,
    });

    await session.cancel();

    expect(cancel).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("createRunDeleteSession", () => {
  it("requires typed confirm before DELETE fires", async () => {
    const deleteRun = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const confirmTyped = vi.fn(() => false);
    const session = createRunDeleteSession({
      deleteRun,
      onSuccess,
      confirmTyped,
      isActive: false,
    });

    await session.deleteRun("run-abc");

    expect(confirmTyped).toHaveBeenCalledWith("run-abc");
    expect(deleteRun).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("fires DELETE with force when active after typed confirm", async () => {
    const deleteRun = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const session = createRunDeleteSession({
      deleteRun,
      onSuccess,
      confirmTyped: () => true,
      isActive: true,
    });

    await session.deleteRun("run-abc");

    expect(deleteRun).toHaveBeenCalledOnce();
    expect(deleteRun).toHaveBeenCalledWith(true);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("fires DELETE without force for terminal runs", async () => {
    const deleteRun = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const session = createRunDeleteSession({
      deleteRun,
      onSuccess,
      confirmTyped: () => true,
      isActive: false,
    });

    await session.deleteRun("run-xyz");

    expect(deleteRun).toHaveBeenCalledWith(false);
  });
});

describe("typedDeleteConfirm", () => {
  it("accepts only an exact run id match", () => {
    expect(typedDeleteConfirm("run-1", () => "run-1")).toBe(true);
    expect(typedDeleteConfirm("run-1", () => "run-2")).toBe(false);
    expect(typedDeleteConfirm("run-1", () => null)).toBe(false);
  });
});
