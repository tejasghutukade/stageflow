import { describe, expect, it } from "vitest";
import { collapseDiff, diffCounts, lineDiff } from "./lineDiffView";

describe("lineDiff", () => {
  it("returns only same lines for equal text", () => {
    expect(lineDiff("a\nb", "a\nb").map((l) => l.op)).toEqual(["same", "same"]);
  });
  it("marks a changed line as remove then add", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "remove", text: "b" },
      { op: "add", text: "B" },
      { op: "same", text: "c" },
    ]);
  });
  it("handles empty sides", () => {
    expect(lineDiff("", "x\ny")).toEqual([
      { op: "add", text: "x" },
      { op: "add", text: "y" },
    ]);
    expect(lineDiff("x", "")).toEqual([{ op: "remove", text: "x" }]);
    expect(lineDiff("", "")).toEqual([]);
  });
  it("counts added and removed", () => {
    expect(diffCounts(lineDiff("a\nb", "a\nc\nd"))).toEqual({ added: 2, removed: 1 });
  });
});

describe("collapseDiff", () => {
  it("collapses long unchanged runs", () => {
    const a = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
    const rows = collapseDiff(lineDiff(a, a.replace("l6", "X")), 1);
    expect(rows[0]).toEqual({ op: "skip", count: 5 });
    expect(rows.filter((r) => r.op === "skip")).toHaveLength(2);
    expect(rows.some((r) => r.op === "add")).toBe(true);
  });
  it("keeps everything when changes are dense", () => {
    expect(collapseDiff(lineDiff("a\nb", "c\nd"), 1).every((r) => r.op !== "skip")).toBe(true);
  });
});
