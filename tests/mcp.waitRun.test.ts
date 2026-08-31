import { describe, expect, it, vi } from "vitest";
import type { RunProjection } from "../src/projection/projectRun.js";
import type { RunDetail, StageSnapshot } from "../src/runstore/port.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PROGRESS_EVERY_MS,
  clampTimeoutMs,
  classifyWaitWake,
  sleepAbortable,
  waitRun,
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

function stage(
  overrides: Partial<StageSnapshot> & Pick<StageSnapshot, "stage_id" | "status">,
): StageSnapshot {
  return {
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    ...overrides,
  };
}

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "p",
    status: "running",
    created_at: "2026-01-01T00:00:00.000Z",
    task_yaml: "id: t\ngoal: g\n",
    stages: [stage({ stage_id: "clarify", status: "running" })],
    pipeline_track: { nodes: [], edges: [] },
    ...overrides,
  };
}

function waitingDetail(): RunDetail {
  return detail({
    waiting_stage_id: "clarify",
    waiting_stage_ids: ["clarify"],
    stages: [
      stage({
        stage_id: "clarify",
        status: "waiting_for_input",
        pending_prompt: {
          kind: "free_text",
          id: "prompt-1",
          message: "name?",
        },
      }),
    ],
  });
}

function terminalDetail(
  status: "succeeded" | "failed" = "succeeded",
): RunDetail {
  return detail({
    status,
    stages: [stage({ stage_id: "clarify", status })],
  });
}

function fakeStore(sequence: RunDetail[] | (() => RunDetail)) {
  let i = 0;
  return {
    async readRun(runId: string): Promise<RunDetail> {
      if (typeof sequence === "function") {
        return { ...sequence(), run_id: runId };
      }
      if (i >= sequence.length) {
        return { ...sequence[sequence.length - 1]!, run_id: runId };
      }
      const next = sequence[i]!;
      i += 1;
      return { ...next, run_id: runId };
    },
  };
}

describe("waitRun helpers", () => {
  it("classifyWaitWake: terminal + until terminal → already / terminal", () => {
    const proj = baseProjection({ status: "succeeded" });
    expect(classifyWaitWake(proj, "terminal", false)).toBe("already");
    expect(classifyWaitWake(proj, "terminal", true)).toBe("terminal");
  });

  it("classifyWaitWake: terminal + until waiting → already / terminal", () => {
    const proj = baseProjection({ status: "succeeded" });
    expect(classifyWaitWake(proj, "waiting", false)).toBe("already");
    expect(classifyWaitWake(proj, "waiting", true)).toBe("terminal");
    const failed = baseProjection({ status: "failed" });
    expect(classifyWaitWake(failed, "waiting", false)).toBe("already");
    expect(classifyWaitWake(failed, "waiting", true)).toBe("terminal");
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

describe("waitRun loop", () => {
  it("T1: already waiting / already terminal → reason already without sleeping", async () => {
    const waiting = await waitRun({
      store: fakeStore([waitingDetail()]),
      runId: "run-1",
      until: "waiting",
      timeoutMs: 5_000,
    });
    expect(waiting).toMatchObject({
      ok: true,
      reason: "already",
      until: "waiting",
    });
    expect(waiting.ok && waiting.elapsed_ms).toBeLessThan(POLL_INTERVAL_MS);

    const terminal = await waitRun({
      store: fakeStore([terminalDetail()]),
      runId: "run-1",
      until: "terminal",
      timeoutMs: 5_000,
    });
    expect(terminal).toMatchObject({
      ok: true,
      reason: "already",
      until: "terminal",
    });
    expect(terminal.ok && terminal.run.status).toBe("succeeded");
    expect(terminal.ok && terminal.elapsed_ms).toBeLessThan(POLL_INTERVAL_MS);
  });

  it("T1b: terminal store + until waiting → already promptly (not timeout)", async () => {
    const result = await waitRun({
      store: fakeStore([terminalDetail()]),
      runId: "run-1",
      until: "waiting",
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "already",
      until: "waiting",
    });
    expect(result.ok && result.run.status).toBe("succeeded");
    expect(result.ok && result.elapsed_ms).toBeLessThan(POLL_INTERVAL_MS);

    const failed = await waitRun({
      store: fakeStore([terminalDetail("failed")]),
      runId: "run-1",
      until: "waiting",
      timeoutMs: 5_000,
    });
    expect(failed).toMatchObject({
      ok: true,
      reason: "already",
      until: "waiting",
    });
    expect(failed.ok && failed.run.status).toBe("failed");
    expect(failed.ok && failed.elapsed_ms).toBeLessThan(POLL_INTERVAL_MS);
  });

  it("T1c: running → terminal under until waiting → reason terminal", async () => {
    const result = await waitRun({
      store: fakeStore([detail(), terminalDetail()]),
      runId: "run-1",
      until: "waiting",
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "terminal",
      until: "waiting",
    });
    expect(result.ok && result.run.status).toBe("succeeded");
  });

  it("T2: transitions to waiting → reason waiting after poll", async () => {
    const result = await waitRun({
      store: fakeStore([detail(), waitingDetail()]),
      runId: "run-1",
      until: "any",
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "waiting",
      until: "any",
    });
    expect(result.ok && result.run.waiting_stage_ids).toContain("clarify");
    expect(result.ok && result.elapsed_ms).toBeGreaterThanOrEqual(
      POLL_INTERVAL_MS - 50,
    );
  });

  it("T3: transitions to terminal → reason terminal", async () => {
    const result = await waitRun({
      store: fakeStore([detail(), terminalDetail()]),
      runId: "run-1",
      until: "terminal",
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "terminal",
      until: "terminal",
    });
    expect(result.ok && result.run.status).toBe("succeeded");
  });

  it("T4: timeout with no wake → reason timeout and nested run", async () => {
    const result = await waitRun({
      store: fakeStore([detail()]),
      runId: "run-1",
      until: "terminal",
      timeoutMs: 350,
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "timeout",
      until: "terminal",
    });
    expect(result.ok && result.run.status).toBe("running");
    expect(result.ok && result.elapsed_ms).toBeGreaterThanOrEqual(300);
  });

  it("T5: abort mid-wait → code aborted; no orphaned timers", async () => {
    const controller = new AbortController();
    const pending = waitRun({
      store: fakeStore([detail()]),
      runId: "run-1",
      until: "terminal",
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    const result = await pending;
    expect(result).toEqual({
      ok: false,
      error: "wait aborted",
      code: "aborted",
    });
  });

  it("T6: invalid timeoutMs → 400-style error", async () => {
    const result = await waitRun({
      store: fakeStore([detail()]),
      runId: "run-1",
      timeoutMs: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: `timeout_ms must be in (0, ${MAX_TIMEOUT_MS}]`,
      status: 400,
    });
  });

  it("T7: missing run → 404-style error", async () => {
    const store = {
      async readRun(runId: string): Promise<RunDetail> {
        throw new Error(`Run not found: ${runId}`);
      },
    };
    const result = await waitRun({
      store,
      runId: "no-such-run",
      timeoutMs: 500,
    });
    expect(result).toEqual({
      ok: false,
      error: "Run not found: no-such-run",
      status: 404,
    });
  });

  it("T8: onProgress invoked on cadence when wait spans PROGRESS_EVERY_MS", async () => {
    const onProgress = vi.fn();
    const result = await waitRun({
      store: fakeStore([detail()]),
      runId: "run-1",
      until: "terminal",
      timeoutMs: PROGRESS_EVERY_MS + 400,
      onProgress,
    });
    expect(result.ok && result.reason).toBe("timeout");
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
      progress: expect.any(Number),
      message: expect.stringContaining("waiting until=terminal"),
    });
  });

  it("T8b: hanging onProgress does not block timeout", async () => {
    const onProgress = vi.fn(() => new Promise<void>(() => {}));
    const result = await waitRun({
      store: fakeStore([detail()]),
      runId: "run-1",
      until: "terminal",
      timeoutMs: PROGRESS_EVERY_MS + 400,
      onProgress,
    });
    expect(result.ok && result.reason).toBe("timeout");
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("T9: until waiting | terminal | any predicate via loop", async () => {
    const waitingOnly = await waitRun({
      store: fakeStore([detail(), waitingDetail()]),
      runId: "run-1",
      until: "waiting",
      timeoutMs: 5_000,
    });
    expect(waitingOnly).toMatchObject({ ok: true, reason: "waiting" });

    const terminalOnly = await waitRun({
      store: fakeStore([waitingDetail()]),
      runId: "run-1",
      until: "terminal",
      timeoutMs: 400,
    });
    expect(terminalOnly).toMatchObject({ ok: true, reason: "timeout" });

    const anyWaiting = await waitRun({
      store: fakeStore([detail(), waitingDetail()]),
      runId: "run-1",
      until: "any",
      timeoutMs: 5_000,
    });
    expect(anyWaiting).toMatchObject({ ok: true, reason: "waiting" });

    const anyTerminal = await waitRun({
      store: fakeStore([detail(), terminalDetail("failed")]),
      runId: "run-1",
      until: "any",
      timeoutMs: 5_000,
    });
    expect(anyTerminal).toMatchObject({ ok: true, reason: "terminal" });
    expect(anyTerminal.ok && anyTerminal.run.status).toBe("failed");
  });
});
