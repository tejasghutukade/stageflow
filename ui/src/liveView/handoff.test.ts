import { describe, expect, it } from "vitest";
import { liveViewHandoffUrl } from "./handoff";

describe("liveViewHandoffUrl", () => {
  it("returns the url only for live_view handoffs", () => {
    expect(liveViewHandoffUrl({ handoff: { kind: "live_view", url: "/api/runs/r/stages/s/live-view" } })).toBe(
      "/api/runs/r/stages/s/live-view",
    );
    expect(liveViewHandoffUrl({ handoff: { kind: "local_window" } })).toBeNull();
    expect(liveViewHandoffUrl({})).toBeNull();
  });
});
