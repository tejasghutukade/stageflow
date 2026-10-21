import { describe, expect, it } from "vitest";
import type { StageLogEvent } from "../../api";
import {
  eventMatchesKindFilter,
  filterStageEvents,
} from "./runEventsView";

const events: StageLogEvent[] = [
  { event: "agent_start", at: "2026-01-01T09:23:04.000Z" },
  { event: "tool_start", at: "2026-01-01T09:23:05.000Z", toolName: "read_file" },
  { event: "message", at: "2026-01-01T09:23:25.000Z", text: "hi" },
  { event: "operator_prompt", at: "2026-01-01T09:23:26.000Z" },
];

describe("runEventsView", () => {
  it("filters tool events", () => {
    const filtered = filterStageEvents(events, "tool");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.event).toBe("tool_start");
  });

  it("operator_prompt filter includes waiting_for_input", () => {
    const withWait: StageLogEvent[] = [
      ...events,
      { event: "waiting_for_input", at: "2026-01-01T09:23:27.000Z" },
    ];
    expect(
      withWait.filter((e) => eventMatchesKindFilter(e, "operator_prompt")),
    ).toHaveLength(2);
  });
});
