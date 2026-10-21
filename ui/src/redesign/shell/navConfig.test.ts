import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "./navConfig";

describe("sidebar", () => {
  it("groups by what the person is doing, with Overview and Inbox pinned above the sections", () => {
    expect(NAV_GROUPS.map((group) => [group.label ?? null, group.items.map((item) => item.id)])).toEqual([
      [null, ["overview", "inbox"]],
      ["Activity", ["runs", "agent-sessions"]],
      ["Build", ["pipelines", "agents", "tasks", "catalog"]],
      ["Connect", ["triggers", "connections"]],
    ]);
  });

  it("names run lists by what they list", () => {
    expect(NAV_GROUPS.flatMap((group) => group.items).find((item) => item.id === "runs")?.label).toBe("Pipeline runs");
  });

  it("gives every item a unique id", () => {
    const ids = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
