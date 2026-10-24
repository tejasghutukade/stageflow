import { describe, expect, it } from "vitest";
import {
  autoMatch,
  buildMapping,
  buildPreviewRequest,
  canConfirm,
  casesForImport,
  confirmLabel,
  detectPastedFormat,
  formatFromFileName,
  freeFields,
  missingRequired,
  normalizeName,
  previewRows,
  setColumn,
  setSplit,
  stageFields,
  summarize,
  toCreateDatasetInput,
} from "./uploadModel";

const fields = stageFields(
  [
    { name: "diff", required: true },
    { name: "plan", required: true },
    { name: "pr_url", required: false },
  ],
  ["findings"],
);

describe("auto match", () => {
  it("normalizes case, underscore, dash and space", () => {
    expect(normalizeName("PR-URL")).toBe("pr_url");
    expect(normalizeName("pr url")).toBe("pr_url");
    expect(normalizeName("input.Diff")).toBe("diff");
  });
  it("matches same-named columns and leaves diff_text unmatched", () => {
    const m = autoMatch(fields, ["diff_text", "Plan", "PR URL", "findings"]);
    expect(m["input.diff"]).toEqual({ column: null });
    expect(m["input.plan"]).toEqual({ column: "Plan" });
    expect(m["input.pr_url"]).toEqual({ column: "PR URL" });
    expect(m["expected.findings"]).toEqual({ column: "findings" });
  });
  it("uses a column once", () => {
    const m = autoMatch(
      stageFields([
        { name: "a", required: false },
        { name: "A", required: false },
      ]),
      ["a"],
    );
    expect(m["input.a"]?.column).toBe("a");
    expect(m["input.A"]?.column).toBeNull();
  });
  it("lists unmatched required fields", () => {
    const m = autoMatch(fields, ["plan"]);
    expect(missingRequired(fields, m)).toEqual(["diff"]);
  });
});

describe("mapping", () => {
  it("builds the request mapping with nulls and split on expected only", () => {
    let m = autoMatch(fields, ["diff", "plan", "issues"]);
    m = setColumn(m, "expected.findings", "issues");
    m = setSplit(m, "expected.findings", ";");
    m = setSplit(m, "input.plan", ";");
    expect(buildMapping(fields, m)).toEqual({
      "input.diff": { column: "diff" },
      "input.plan": { column: "plan" },
      "input.pr_url": null,
      "expected.findings": { column: "issues", split: ";" },
    });
  });
  it("keeps split when the column changes and clears it with an empty value", () => {
    let m = setSplit({}, "expected.findings", ";");
    m = setColumn(m, "expected.findings", "x");
    expect(m["expected.findings"]).toEqual({ column: "x", split: ";" });
    expect(setSplit(m, "expected.findings", "")["expected.findings"]).toEqual({ column: "x" });
  });
  it("free mode maps every column to itself", () => {
    const f = freeFields(["a", "b"]);
    expect(autoMatch(f, ["a", "b"])).toEqual({ "input.a": { column: "a" }, "input.b": { column: "b" } });
  });
});

describe("formats", () => {
  it("detects from file name and pasted text", () => {
    expect(formatFromFileName("x.CSV")).toBe("csv");
    expect(formatFromFileName("x.dataset.jsonl")).toBe("jsonl");
    expect(formatFromFileName("x.json")).toBe("json");
    expect(formatFromFileName("x.txt")).toBeNull();
    expect(detectPastedFormat('{"a":1}\n\n{"a":2}')).toBe("jsonl");
    expect(detectPastedFormat('a,b\n{"x":1}')).toBe("csv");
    expect(detectPastedFormat("  \n")).toBeNull();
  });
  it("preview request omits defaults", () => {
    expect(
      buildPreviewRequest({ format: "csv", content: "a", delimiter: ",", mapping: {}, target: { stage_id: "s" } }),
    ).toEqual({ format: "csv", content: "a", mapping: {}, target: { stage_id: "s" } });
    expect(buildPreviewRequest({ format: "csv", content: "a", delimiter: ";", projectRoot: "/r" })).toEqual({
      format: "csv",
      content: "a",
      delimiter: ";",
      project_root: "/r",
    });
    expect(buildPreviewRequest({ format: "jsonl", content: "a", delimiter: ";" }).delimiter).toBeUndefined();
  });
});

const row = (
  index: number,
  status: "ready" | "skipped",
  reason?: string,
  input: Record<string, unknown> = { diff: "d", plan: "" },
) => ({
  index,
  case: { id: `c00${index}`, input },
  status,
  ...(reason ? { reason } : {}),
});

describe("summary", () => {
  it("builds the counts line", () => {
    const rows = [row(1, "ready"), row(2, "skipped", "plan is empty"), row(3, "skipped", "plan is empty")];
    expect(summarize({ rows, counts: { ready: 12, skipped: 2 } })).toBe(
      "12 cases ready · 2 skipped because plan is empty",
    );
    expect(summarize({ rows: [], counts: { ready: 1, skipped: 0 } })).toBe("1 case ready");
    expect(summarize({ rows: [], counts: { ready: 0, skipped: 0 } })).toBe("No cases ready");
    expect(
      summarize({ rows: [row(1, "skipped", "a"), row(2, "skipped", "b")], counts: { ready: 3, skipped: 2 } }),
    ).toBe("3 cases ready · 2 skipped (a, b)");
    expect(summarize(null)).toBe("");
  });
  it("preview rows show five with the empty marker", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row(i + 1, i === 2 ? "skipped" : "ready", i === 2 ? "plan is empty" : undefined),
    );
    const view = previewRows({ rows }, ["diff", "plan"]);
    expect(view).toHaveLength(5);
    expect(view[2]).toMatchObject({ status: "skipped", secondary: "(empty)", reason: "plan is empty" });
  });
});

describe("confirm", () => {
  it("labels the button", () => {
    expect(confirmLabel(12, "append", 24)).toBe("Add 12 cases");
    expect(confirmLabel(12, "replace", 24)).toBe("Replace with 12 cases");
    expect(confirmLabel(0, "append", 24)).toBe("Nothing to add");
    expect(canConfirm({ counts: { ready: 0, skipped: 1 } }, false)).toBe(false);
    expect(canConfirm({ counts: { ready: 1, skipped: 0 } }, true)).toBe(false);
  });
  it("strips csv ids and colliding ids on append only", () => {
    const cases = [
      { id: "c001", input: {} },
      { id: "x9", input: {} },
    ];
    expect(casesForImport(cases, { format: "csv", mode: "append", existingIds: [] })).toEqual([
      { input: {} },
      { input: {} },
    ]);
    expect(casesForImport(cases, { format: "jsonl", mode: "append", existingIds: ["c001"] })).toEqual([
      { input: {} },
      { id: "x9", input: {} },
    ]);
    expect(casesForImport(cases, { format: "jsonl", mode: "replace", existingIds: ["c001"] })).toEqual(cases);
  });
  it("builds create and append requests", () => {
    const req = {
      mode: "append" as const,
      cases: [{ input: {} }],
      ready: 1,
      skipped: 0,
      fileName: "f",
      format: "csv" as const,
    };
    expect(toCreateDatasetInput(req, { name: "n", projectRoot: "/r" })).toEqual({
      project_root: "/r",
      name: "n",
      cases: [{ input: {} }],
    });
    expect(toCreateDatasetInput(req, { datasetId: "d", baseHash: "h" })).toEqual({
      dataset_id: "d",
      mode: "append",
      cases: [{ input: {} }],
      base_hash: "h",
    });
  });
});
