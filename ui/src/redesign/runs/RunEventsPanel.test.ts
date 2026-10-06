import { describe, expect, it } from "vitest";
import type { StageLogEvent } from "../../api";
import {
  buildEventRows,
  filterEventsByKinds,
  formatEventTime,
  uniqueEventKinds,
} from "./runEventsView";

describe("runEventsView", () => {
  const events: StageLogEvent[] = [
    { event: "agent_start", at: "2026-10-05T09:23:04.000Z" },
    { event: "tool_start", at: "2026-10-05T09:23:05.000Z", toolName: "read" },
    { event: "message", at: "2026-10-05T09:23:25.000Z", role: "assistant", text: "hi" },
    { event: "waiting_for_input", at: "2026-10-05T09:23:26.000Z" },
  ];

  it("lists unique kinds sorted", () => {
    expect(uniqueEventKinds(events)).toEqual([
      "agent_start",
      "message",
      "tool_start",
      "waiting_for_input",
    ]);
  });

  it("filters by active kind set", () => {
    const onlyTools = filterEventsByKinds(events, new Set(["tool_start"]));
    expect(onlyTools).toHaveLength(1);
    expect(onlyTools[0].event).toBe("tool_start");
    expect(filterEventsByKinds(events, null)).toHaveLength(events.length);
  });

  it("formats event time as HH:MM:SS", () => {
    const label = formatEventTime("2026-10-05T09:23:04.000Z");
    expect(label).toMatch(/09:23:04/);
  });

  it("buildEventRows includes labels and message detail", () => {
    const rows = buildEventRows(events);
    expect(rows[2].kind).toBe("message");
    expect(rows[2].label).toContain("assistant");
    expect(rows[3].label.length).toBeGreaterThan(0);
  });
});
