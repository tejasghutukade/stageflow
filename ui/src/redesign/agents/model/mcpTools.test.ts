import { describe, expect, it } from "vitest";
import { filterRows, setMany, toggleTool, toolRows } from "./mcpTools";

describe("mcp tool picking", () => {
  const listed = [{ name: "search", description: "Find pages" }, { name: "create_page" }];

  it("keeps granted tools the server no longer lists, marked missing", () => {
    expect(toolRows(listed, ["search", "gone", "*"])).toEqual([
      { name: "search", description: "Find pages", missing: false },
      { name: "create_page", missing: false },
      { name: "gone", missing: true },
    ]);
  });

  it("toggles one tool without duplicating", () => {
    expect(toggleTool(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleTool(["a", "b"], "b", true)).toEqual(["a", "b"]);
    expect(toggleTool(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("ticks or clears only the shown tools", () => {
    expect(setMany(["x"], ["a", "b"], true)).toEqual(["x", "a", "b"]);
    expect(setMany(["x", "a"], ["a", "b"], true)).toEqual(["x", "a", "b"]);
    expect(setMany(["x", "a", "b"], ["a", "b"], false)).toEqual(["x"]);
  });

  it("filters by name or description", () => {
    expect(filterRows(listed, "page").map((r) => r.name)).toEqual(["search", "create_page"]);
    expect(filterRows(listed, "CREATE").map((r) => r.name)).toEqual(["create_page"]);
    expect(filterRows(listed, "  ")).toHaveLength(2);
  });
});
