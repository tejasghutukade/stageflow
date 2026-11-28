import { describe, expect, it } from "vitest";
import { TABLE_ROW_CAP, capTableRows, nextTableSort, sortTableRows, tableFromCsv, tableFromJson } from "./tableModel";

describe("table model", () => {
  it("builds a JSON table from the union of keys in first-seen order", () => {
    const built = tableFromJson('[{"a":1,"b":2},{"b":3,"c":4}]');
    expect(built).toEqual({
      ok: true,
      table: {
        columns: ["a", "b", "c"],
        rows: [
          ["1", "2", ""],
          ["", "3", "4"],
        ],
      },
    });
  });

  it("rejects JSON that is not an array of objects", () => {
    expect(tableFromJson("{")).toEqual({ ok: false, reason: "invalid" });
    expect(tableFromJson('["x"]')).toEqual({ ok: false, reason: "invalid" });
    expect(tableFromJson("[]")).toEqual({ ok: false, reason: "empty" });
  });

  it("pads ragged CSV rows and names missing headers", () => {
    const built = tableFromCsv("a,b\n1\n2,3,4\n");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.table.columns).toEqual(["a", "b", "Column 3"]);
    expect(built.table.rows).toEqual([
      ["1", "", ""],
      ["2", "3", "4"],
    ]);
  });

  it("sorts stably and compares numbers numerically", () => {
    const rows = [
      ["10", "b"],
      ["2", "a"],
      ["2", "c"],
      ["10", "a"],
    ];
    expect(sortTableRows(rows, 0, "asc")).toEqual([
      ["2", "a"],
      ["2", "c"],
      ["10", "b"],
      ["10", "a"],
    ]);
    expect(sortTableRows(rows, 0, "desc")[0]).toEqual(["10", "b"]);
    expect(sortTableRows(rows, 0, "desc")[1]).toEqual(["10", "a"]);
  });

  it("clears the sort on a third click of the same header", () => {
    const asc = nextTableSort(null, 1);
    expect(asc).toEqual({ column: 1, direction: "asc" });
    const desc = nextTableSort(asc, 1);
    expect(desc).toEqual({ column: 1, direction: "desc" });
    expect(nextTableSort(desc, 1)).toBeNull();
    expect(nextTableSort(desc, 0)).toEqual({ column: 0, direction: "asc" });
  });

  it("caps the displayed rows and names the remainder", () => {
    const rows = Array.from({ length: TABLE_ROW_CAP + 1 }, (_, index) => [String(index)]);
    const capped = capTableRows(rows);
    expect(capped.rows).toHaveLength(TABLE_ROW_CAP);
    expect(capped.total).toBe(TABLE_ROW_CAP + 1);
    expect(capped.note).toBe(`showing first ${TABLE_ROW_CAP} of ${TABLE_ROW_CAP + 1}`);
    expect(capTableRows([["1"]]).note).toBeNull();
  });
});
