import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "./api";
import {
  diffWaitingAppearances,
  readNotifyPreference,
  writeNotifyPreference,
} from "./useWaitingNotifications";

function summary(
  overrides: Partial<RunSummary> & Pick<RunSummary, "run_id">,
): RunSummary {
  return {
    pipeline_id: "pipe",
    status: "running",
    created_at: "2026-08-18T00:00:00.000Z",
    stages: [],
    ...overrides,
  };
}

describe("waiting notification first-appearance", () => {
  it("emits only on first appearance in the waiting view", () => {
    const wait = summary({ run_id: "w1", waiting_stage_id: "ask" });
    const first = diffWaitingAppearances([wait], null);
    expect(first.emit).toEqual([]);
    expect([...first.nextSeen]).toEqual(["w1"]);

    const arrived = summary({ run_id: "w2", waiting_stage_id: "ask" });
    const second = diffWaitingAppearances([wait, arrived], first.nextSeen);
    expect(second.emit.map((run) => run.run_id)).toEqual(["w2"]);

    const third = diffWaitingAppearances([wait, arrived], second.nextSeen);
    expect(third.emit).toEqual([]);
  });

  it("does not emit on subsequent ticks while the run stays waiting", () => {
    const wait = summary({ run_id: "w1", waiting_stage_id: "ask" });
    let seen: Set<string> | null = null;
    for (let i = 0; i < 3; i++) {
      const next = diffWaitingAppearances([wait], seen);
      expect(next.emit).toEqual([]);
      seen = next.nextSeen;
    }
  });

  it("re-emits if a run leaves the waiting view and returns", () => {
    const wait = summary({ run_id: "w1", waiting_stage_id: "ask" });
    const seeded = diffWaitingAppearances([wait], null);
    const left = diffWaitingAppearances([], seeded.nextSeen);
    expect(left.emit).toEqual([]);
    expect(left.nextSeen.size).toBe(0);

    const returned = diffWaitingAppearances([wait], left.nextSeen);
    expect(returned.emit.map((run) => run.run_id)).toEqual(["w1"]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notify preference key", () => {
  it("reads and writes sf-notify-waiting", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    });
    writeNotifyPreference("system");
    expect(data.get("sf-notify-waiting")).toBe("system");
    expect(data.has("stageflow-notify-waiting")).toBe(false);
    expect(readNotifyPreference()).toBe("system");
  });
});
