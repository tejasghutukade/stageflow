import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv } from "../src/config/csv.js";

describe("parseCsv", () => {
  it("parses plain records and ignores a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("keeps embedded newlines inside quotes", () => {
    expect(parseCsv('a\n"l1\nl2"\n')).toEqual([["a"], ["l1\nl2"]]);
  });

  it("accepts CRLF line endings and no trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseCsv("﻿id,x\n1,2")[0]).toEqual(["id", "x"]);
  });

  it("supports a custom delimiter", () => {
    expect(parseCsv("a;b\n1,5;2", { delimiter: ";" })).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });

  it("keeps empty cells and quoted empty strings", () => {
    expect(parseCsv('a,,""\n')).toEqual([["a", "", ""]]);
  });

  it("throws CsvParseError naming the row for an unterminated quote", () => {
    try {
      parseCsv('a\n"oops');
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CsvParseError);
      expect((err as CsvParseError).record).toBe(2);
    }
  });

  it("rejects a stray quote inside an unquoted field", () => {
    expect(() => parseCsv('a\nb"c')).toThrow(CsvParseError);
  });

  it("rejects an invalid delimiter", () => {
    expect(() => parseCsv("a", { delimiter: '"' })).toThrow();
  });
});
