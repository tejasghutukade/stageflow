import { describe, expect, it } from "vitest";
import {
  autoMatch,
  buildFullMapping,
  buildPreviewRequest,
  cellsByColumn,
  checkUploadFile,
  dragDepth,
  firstFile,
  isFileDrag,
  MAX_UPLOAD_BYTES,
  defaultExpectedKey,
  extraColumns,
  initExtras,
  missingRequired,
  patchExtra,
  setColumn,
  stageFields,
  suggestSplit,
} from "./uploadModel";

const inputs = [
  { name: "ticket", required: true },
  { name: "channel", required: false },
];

describe("defaultExpectedKey", () => {
  it("strips a leading expected_ and normalises", () => {
    expect(defaultExpectedKey("expected_category")).toBe("category");
    expect(defaultExpectedKey("Expected Priority")).toBe("priority");
    expect(defaultExpectedKey("expected-key-facts")).toBe("key_facts");
    expect(defaultExpectedKey("expected.tags")).toBe("tags");
  });
  it("lowercases and joins other names", () => {
    expect(defaultExpectedKey("Key Facts")).toBe("key_facts");
    expect(defaultExpectedKey("key-facts")).toBe("key_facts");
  });
  it("keeps the name when stripping would empty it", () => {
    expect(defaultExpectedKey("expected_")).toBe("expected_");
  });
});

describe("suggestSplit", () => {
  it("suggests ; when most non-empty cells contain one", () => {
    expect(suggestSplit(["a;b", "c;d", "e", ""])).toBe(";");
  });
  it("suggests nothing when few cells contain one", () => {
    expect(suggestSplit(["a;b", "c", "d", "e"])).toBe("");
    expect(suggestSplit(["", " "])).toBe("");
    expect(suggestSplit([])).toBe("");
  });
});

describe("reference-data rows", () => {
  const columns = ["ticket", "channel", "expected_category", "key_facts", "notes"];
  const fields = stageFields(inputs);
  const state = autoMatch(fields, columns);

  it("lists only columns not used by an input field", () => {
    expect(extraColumns(columns, fields, state)).toEqual(["expected_category", "key_facts", "notes"]);
  });

  it("does not offer a column once an input field takes it", () => {
    const moved = setColumn(state, "input.channel", "notes");
    expect(extraColumns(columns, fields, moved)).toEqual(["channel", "expected_category", "key_facts"]);
  });

  it("does not duplicate grader-driven rows", () => {
    const withGrader = stageFields(inputs, ["category"]);
    const m = autoMatch(withGrader, ["ticket", "category", "key_facts"]);
    expect(extraColumns(["ticket", "category", "key_facts"], withGrader, m)).toEqual(["key_facts"]);
  });

  it("pre-checks expected_* columns and suggests ; from cells", () => {
    const cells = cellsByColumn(
      [
        { case: { input: { key_facts: "a; b", expected_category: "bug" } } },
        { case: { input: { key_facts: "c;d", expected_category: "ask" } } },
      ],
      columns,
    );
    const extras = initExtras(columns, cells);
    expect(extras.expected_category).toEqual({ enabled: true, key: "category", split: "" });
    expect(extras.key_facts).toEqual({ enabled: false, key: "key_facts", split: ";" });
    expect(extras.notes.enabled).toBe(false);
  });

  it("builds expected.<key> entries with split for checked rows only", () => {
    let extras = initExtras(columns);
    extras = patchExtra(extras, "key_facts", { enabled: true, split: ";" });
    const mapping = buildFullMapping(fields, state, extras, columns);
    expect(mapping["input.ticket"]).toEqual({ column: "ticket" });
    expect(mapping["expected.category"]).toEqual({ column: "expected_category" });
    expect(mapping["expected.key_facts"]).toEqual({ column: "key_facts", split: ";" });
    expect(mapping["expected.notes"]).toBeUndefined();
  });

  it("honours an edited key and drops empty, duplicate and grader-clashing keys", () => {
    let extras = initExtras(columns);
    extras = patchExtra(extras, "key_facts", { enabled: true, key: "Facts List" });
    extras = patchExtra(extras, "notes", { enabled: true, key: "category" });
    const mapping = buildFullMapping(fields, state, extras, columns);
    expect(mapping["expected.facts_list"]).toEqual({ column: "key_facts" });
    expect(mapping["expected.category"]).toEqual({ column: "expected_category" });
    expect(Object.keys(mapping).filter((k) => k.startsWith("expected."))).toHaveLength(2);

    const blank = patchExtra(extras, "key_facts", { key: "  " });
    expect(Object.keys(buildFullMapping(fields, state, blank, columns)).some((k) => k === "expected.")).toBe(false);

    const withGrader = stageFields(inputs, ["category"]);
    const gm = autoMatch(withGrader, ["ticket", "channel", "category", "expected_category"]);
    const full = buildFullMapping(withGrader, gm, initExtras(["ticket", "channel", "category", "expected_category"]), [
      "ticket",
      "channel",
      "category",
      "expected_category",
    ]);
    expect(full["expected.category"]).toEqual({ column: "category" });
  });

  it("leaves required-field skipping unchanged by reference rows", () => {
    const noTicket = setColumn(state, "input.ticket", null);
    expect(missingRequired(fields, noTicket)).toEqual(["ticket"]);
    expect(extraColumns(columns, fields, noTicket)).toContain("ticket");
    const mapping = buildFullMapping(fields, noTicket, initExtras(columns), columns);
    expect(mapping["input.ticket"]).toBeNull();
  });

  it("builds no extra entries without stage-aware extras", () => {
    const mapping = buildFullMapping(fields, state, null, columns);
    expect(Object.keys(mapping).every((k) => k.startsWith("input."))).toBe(true);
  });

  it("carries the mapping in the preview request", () => {
    const mapping = buildFullMapping(fields, state, initExtras(columns), columns);
    const req = buildPreviewRequest({ format: "csv", content: "x", mapping });
    expect(req.mapping?.["expected.category"]).toEqual({ column: "expected_category" });
  });
});

describe("drag and drop", () => {
  it("checks extension then size", () => {
    expect(checkUploadFile({ name: "a.CSV", size: 10 })).toEqual({ format: "csv" });
    expect(checkUploadFile({ name: "a.ndjson", size: 10 })).toEqual({ format: "jsonl" });
    expect(checkUploadFile({ name: "a.txt", size: 10 })).toEqual({ error: "Use a .jsonl, .json or .csv file." });
    expect(checkUploadFile({ name: "a.json", size: MAX_UPLOAD_BYTES + 1 })).toEqual({
      error: "That file is over the 50 MB limit.",
    });
  });
  it("recognises file drags only", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["text/plain", "Files"])).toBe(true);
    expect(isFileDrag(["text/uri-list"])).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
  it("picks the first file", () => {
    expect(firstFile(["a", "b"])).toBe("a");
    expect(firstFile([])).toBeUndefined();
    expect(firstFile(null)).toBeUndefined();
  });
  it("tracks drag depth without going negative", () => {
    expect(dragDepth(dragDepth(0, "enter"), "enter")).toBe(2);
    expect(dragDepth(0, "leave")).toBe(0);
    expect(dragDepth(3, "reset")).toBe(0);
  });
});
