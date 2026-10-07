import { describe, expect, it } from "vitest";
import { canWatchBrowser, liveViewHandoffUrl, watchBrowserUrl } from "./handoff";

describe("liveViewHandoffUrl", () => {
  it("returns the url only for live_view handoffs", () => {
    expect(liveViewHandoffUrl({ handoff: { kind: "live_view", url: "/api/runs/r/stages/s/live-view" } })).toBe(
      "/api/runs/r/stages/s/live-view",
    );
    expect(liveViewHandoffUrl({ handoff: { kind: "local_window" } })).toBeNull();
    expect(liveViewHandoffUrl({})).toBeNull();
  });
});

describe("watch browser", () => {
  it("targets the stage live view route with encoded ids", () => {
    expect(watchBrowserUrl("run 1", "s/1")).toBe("/api/runs/run%201/stages/s%2F1/live-view");
  });

  it("is offered only while the stage is running or waiting", () => {
    expect(canWatchBrowser("running")).toBe(true);
    expect(canWatchBrowser("waiting_for_input")).toBe(true);
    for (const status of ["pending", "completed", "failed", "cancelled"]) expect(canWatchBrowser(status)).toBe(false);
  });
});
