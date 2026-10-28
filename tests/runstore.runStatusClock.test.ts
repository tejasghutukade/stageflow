import { describe, expect, it } from "vitest";
import {
  isRunClockTerminal,
  nextFinishedAt,
  RUN_CLOCK_TERMINAL_STATUSES,
} from "../src/runstore/runStatusClock.js";

describe("isRunClockTerminal", () => {
  it("is true only for succeeded, failed, and cancelled", () => {
    expect(RUN_CLOCK_TERMINAL_STATUSES).toEqual([
      "succeeded",
      "failed",
      "cancelled",
    ]);
    expect(isRunClockTerminal("succeeded")).toBe(true);
    expect(isRunClockTerminal("failed")).toBe(true);
    expect(isRunClockTerminal("cancelled")).toBe(true);
    expect(isRunClockTerminal("running")).toBe(false);
    expect(isRunClockTerminal("created")).toBe(false);
    expect(isRunClockTerminal("queued")).toBe(false);
    expect(isRunClockTerminal(undefined)).toBe(false);
  });
});

describe("nextFinishedAt", () => {
  const now = "2026-10-27T12:00:00.000Z";
  const prior = "2026-10-27T11:00:00.000Z";

  it("stamps finished_at when entering a terminal status with none set", () => {
    expect(
      nextFinishedAt({
        nextStatus: "failed",
        currentFinishedAt: null,
        now,
      }),
    ).toEqual({ action: "stamp", finishedAt: now });
    expect(
      nextFinishedAt({
        nextStatus: "succeeded",
        currentFinishedAt: undefined,
        now,
      }),
    ).toEqual({ action: "stamp", finishedAt: now });
    expect(
      nextFinishedAt({
        nextStatus: "cancelled",
        currentFinishedAt: "",
        now,
      }),
    ).toEqual({ action: "stamp", finishedAt: now });
  });

  it("keeps the first finish when already stamped", () => {
    expect(
      nextFinishedAt({
        nextStatus: "cancelled",
        currentFinishedAt: prior,
        now,
      }),
    ).toEqual({ action: "keep" });
    expect(
      nextFinishedAt({
        nextStatus: "failed",
        currentFinishedAt: prior,
        now,
      }),
    ).toEqual({ action: "keep" });
  });

  it("clears finished_at when reopening to a non-terminal status", () => {
    expect(
      nextFinishedAt({
        nextStatus: "running",
        currentFinishedAt: prior,
        now,
      }),
    ).toEqual({ action: "clear" });
    expect(
      nextFinishedAt({
        nextStatus: "queued",
        currentFinishedAt: prior,
        now,
      }),
    ).toEqual({ action: "clear" });
    expect(
      nextFinishedAt({
        nextStatus: "created",
        currentFinishedAt: null,
        now,
      }),
    ).toEqual({ action: "clear" });
  });
});
