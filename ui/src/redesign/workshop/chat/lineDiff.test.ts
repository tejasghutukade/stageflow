import { describe, expect, it } from "vitest";
import {
  artifactDiff,
  collapseContext,
  diffLines,
  diffTotals,
  splitLines,
  sumTotals,
} from "./lineDiff";

describe("splitLines", () => {
  it("drops a single trailing newline and handles empty input", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines(undefined)).toEqual([]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  it("marks every line added for a new file", () => {
    const lines = diffLines(undefined, "a\nb");
    expect(lines).toEqual([
      { kind: "added", newLine: 1, text: "a" },
      { kind: "added", newLine: 2, text: "b" },
    ]);
  });

  it("marks every line removed for a deleted file", () => {
    expect(diffLines("a\nb", "")).toEqual([
      { kind: "removed", oldLine: 1, text: "a" },
      { kind: "removed", oldLine: 2, text: "b" },
    ]);
  });

  it("puts removed lines before added lines in a replaced block", () => {
    const lines = diffLines(
      "command: npm test\non_verify_fail: fail\nend",
      "command: npm test\non_verify_fail: retry\nmax_retries: 1\nend",
    );
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["context", "command: npm test"],
      ["removed", "on_verify_fail: fail"],
      ["added", "on_verify_fail: retry"],
      ["added", "max_retries: 1"],
      ["context", "end"],
    ]);
    expect(lines[4]).toMatchObject({ oldLine: 3, newLine: 4 });
  });

  it("finds the longest common subsequence in the middle", () => {
    const lines = diffLines("a\nx\nb\nc", "a\nb\ny\nc");
    expect(lines.map((line) => `${line.kind[0]}${line.text}`)).toEqual([
      "ca",
      "rx",
      "cb",
      "ay",
      "cc",
    ]);
  });

  it("returns only context for identical text", () => {
    const lines = diffLines("a\nb", "a\nb");
    expect(lines.every((line) => line.kind === "context")).toBe(true);
    expect(diffTotals(lines)).toEqual({ added: 0, removed: 0 });
  });
});

describe("collapseContext", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 10", "line ten");

  it("keeps three lines around a change and collapses the rest", () => {
    const rows = collapseContext(diffLines(before, after));
    expect(rows[0]).toEqual({ kind: "skip", count: 6 });
    expect(rows.slice(1, 4).map((row) => row.kind)).toEqual([
      "context",
      "context",
      "context",
    ]);
    expect(rows[4]).toMatchObject({ kind: "removed", text: "line 10" });
    expect(rows[5]).toMatchObject({ kind: "added", text: "line ten" });
    expect(rows[rows.length - 1]).toEqual({ kind: "skip", count: 7 });
    expect(rows).toHaveLength(10);
  });

  it("merges nearby hunks and returns nothing for an unchanged file", () => {
    const twoChanges = before.replace("line 3", "x").replace("line 6", "y");
    const rows = collapseContext(diffLines(before, twoChanges));
    expect(rows.filter((row) => row.kind === "skip")).toEqual([
      { kind: "skip", count: 11 },
    ]);
    expect(collapseContext(diffLines(before, before))).toEqual([]);
  });
});

describe("artifactDiff", () => {
  it("returns rows and totals", () => {
    const diff = artifactDiff({ before: "a\nb", after: "a\nc\nd" });
    expect(diff.totals).toEqual({ added: 2, removed: 1 });
    expect(sumTotals([diff.totals, { added: 1, removed: 0 }])).toEqual({
      added: 3,
      removed: 1,
    });
  });
});
