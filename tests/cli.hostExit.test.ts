import { describe, expect, it } from "vitest";
import {
  HOST_EXIT,
  DEFAULT_SHUTDOWN_GRACE_MS,
  CHECKPOINT_RESERVE_MS,
  workerBudgetMs,
} from "../src/server/shutdown.js";

describe("Host exit codes", () => {
  it("publishes the Slot 4 Host exit table", () => {
    expect(HOST_EXIT.CLEAN).toBe(0);
    expect(HOST_EXIT.CRASH).toBe(1);
    expect(HOST_EXIT.RESERVED).toBe(2);
    expect(HOST_EXIT.BAD_CONFIG).toBe(3);
    expect(HOST_EXIT.STORE_NEWER).toBe(4);
    expect(HOST_EXIT.FORCED).toBe(5);
    expect(HOST_EXIT.ESCALATED).toBe(6);
  });

  it("reserves final 2s of grace for checkpoint", () => {
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(8000);
    expect(CHECKPOINT_RESERVE_MS).toBe(2000);
    expect(workerBudgetMs(DEFAULT_SHUTDOWN_GRACE_MS)).toBe(6000);
  });
});
