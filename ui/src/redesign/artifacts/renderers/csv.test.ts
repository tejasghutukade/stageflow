import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("parses quoted fields, embedded commas, and escaped quotes", () => {
    expect(parseCsv('name,note\n"say ""hi""",plain\n"a,b",c\n')).toEqual([
      ["name", "note"],
      ['say "hi"', "plain"],
      ["a,b", "c"],
    ]);
  });

  it("keeps an embedded newline inside quotes", () => {
    expect(parseCsv('"hello\nworld",3\n')).toEqual([["hello\nworld", "3"]]);
  });

  it("keeps ragged rows", () => {
    expect(parseCsv("a,b,c\n1,2\nonly\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2"],
      ["only"],
    ]);
  });

  it("returns no rows for an empty file and strips a leading BOM", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\uFEFFa,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("rejects an unclosed quote", () => {
    expect(() => parseCsv('"oops')).toThrow(/Unclosed quote/);
  });
});
