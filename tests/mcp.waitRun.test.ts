import { describe, expect, it } from "vitest";
import type { RunProjection } from "../src/projection/projectRun.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  clampTimeoutMs,
  classifyWaitWake,
  sleepAbortable,
} from "../src/mcp/waitRun.js";

function baseProjection(
  overrides: Partial<RunProjection> = {},
): Pick<
  RunProjection,
  "status" | "waiting_stage_ids" | "waiting_stage_id" | "stages"
> {
  return {
    status: "running",
    stages: [],
    ...overrides,
  };
}

describe("waitRun helpers", () => {
  it("classifyWaitWake: terminal + until terminal → already / terminal", () => {
    const proj = baseProjection({ status: "succeeded" });
    expect(classifyWaitWake(proj, "terminal", false)).toBe("already");
    expect(classifyWaitWake(proj, "terminal", true)).toBe("terminal");
  });

  it("classifyWaitWake: waiting_* + until waiting wakes; until terminal does not", () => {
    const proj = baseProjection({
      waiting_stage_ids: ["clarify"],
      waiting_stage_id: "clarify",
      stages: [
        {
          stage_id: "clarify",
          status: "waiting_for_input",
          envelope: null,
          artifacts: [],
        },
      ],
    });
    expect(classifyWaitWake(proj, "waiting", false)).toBe("already");
    expect(classifyWaitWake(proj, "waiting", true)).toBe("waiting");
    expect(classifyWaitWake(proj, "terminal", false)).toBeNull();
    expect(classifyWaitWake(proj, "terminal", true)).toBeNull();
  });

  it("classifyWaitWake: until any wakes on waiting or terminal", () => {
    const waiting = baseProjection({
      waiting_stage_ids: ["clarify"],
      stages: [
        {
          stage_id: "clarify",
          status: "waiting_for_input",
          envelope: null,
          artifacts: [],
        },
      ],
    });
    expect(classifyWaitWake(waiting, "any", true)).toBe("waiting");

    const terminal = baseProjection({ status: "failed" });
    expect(classifyWaitWake(terminal, "any", true)).toBe("terminal");

    const running = baseProjection({ status: "running" });
    expect(classifyWaitWake(running, "any", false)).toBeNull();
  });

  it("clampTimeoutMs: default, accept, reject bounds", () => {
    expect(clampTimeoutMs(undefined)).toEqual({
      ok: true,
      value: DEFAULT_TIMEOUT_MS,
    });
    expect(clampTimeoutMs(1)).toEqual({ ok: true, value: 1 });
    expect(clampTimeoutMs(MAX_TIMEOUT_MS)).toEqual({
      ok: true,
      value: MAX_TIMEOUT_MS,
    });
    expect(clampTimeoutMs(0).ok).toBe(false);
    expect(clampTimeoutMs(-1).ok).toBe(false);
    expect(clampTimeoutMs(MAX_TIMEOUT_MS + 1).ok).toBe(false);
  });

  it("sleepAbortable resolves and aborts promptly", async () => {
    const t0 = Date.now();
    await sleepAbortable(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);

    const controller = new AbortController();
    const pending = sleepAbortable(5_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    await expect(
      sleepAbortable(5_000, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "aborted" });
  });
});
