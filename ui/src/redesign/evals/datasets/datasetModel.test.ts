import { describe, expect, it } from "vitest";
import type { EvalDatasetCase } from "../../../api/evalTypes";
import {
  buildAddCase,
  buildCellEditOp,
  checkLabel,
  datasetColumns,
  datasetQuery,
  datasetTabs,
  expectedColumns,
  invalidBanner,
  nextCaseId,
  pageInfo,
  parseCellText,
  parseTagsText,
  railMeta,
  saveLabel,
  saveReducer,
  serializeJsonl,
  validateDatasetName,
} from "./datasetModel";

const c = (over: Partial<EvalDatasetCase> = {}): EvalDatasetCase => ({
  id: "c001",
  input: { diff: "+x", plan: "p", opts: { a: 1 } },
  expected: { findings: "f", severity: "low", extra: 1 },
  tags: ["auth"],
  input_check: { valid: true },
  ...over,
});

describe("tabs and query", () => {
  it("counts tabs", () => {
    expect(datasetTabs({ cases_total: 24, invalid_total: 3, tagged_total: 9 }).map((t) => t.count)).toEqual([24, 3, 9]);
  });
  it("builds a paged query", () => {
    expect(datasetQuery({ tab: "invalid", q: " x ", page: 2, evalId: "e", projectRoot: "/r" })).toEqual({
      offset: 50,
      limit: 25,
      filter: "invalid",
      q: "x",
      eval_id: "e",
      project_root: "/r",
    });
    expect(datasetQuery({ tab: "all", q: "", page: 0 })).toEqual({ offset: 0, limit: 25, filter: "all" });
  });
});

describe("pageInfo", () => {
  it("handles boundaries", () => {
    expect(pageInfo(0, 24).label).toBe("Showing 1 to 24 of 24");
    expect(pageInfo(0, 25).hasNext).toBe(false);
    const p = pageInfo(1, 26);
    expect(p.label).toBe("Showing 26 to 26 of 26");
    expect(p.hasPrev).toBe(true);
    expect(pageInfo(9, 26).page).toBe(1);
    expect(pageInfo(0, 0).label).toBe("No cases");
  });
});

describe("columns", () => {
  it("shows at most two expected columns and counts the rest", () => {
    const cols = datasetColumns({ input_fields: [{ name: "diff", required: true }], cases: [c()] });
    expect(cols.columns.map((x) => x.id)).toEqual([
      "#",
      "input.diff",
      "expected.findings",
      "expected.severity",
      "tags",
      "check",
    ]);
    expect(cols.moreExpected).toBe(1);
  });
  it("falls back to input keys and scalar expected", () => {
    const cols = datasetColumns({ input_fields: [], cases: [c({ expected: "text", input: { a: "1" } })] });
    expect(cols.columns.map((x) => x.id)).toContain("input.a");
    expect(cols.columns.map((x) => x.id)).toContain("expected");
    expect(expectedColumns([]).shown).toEqual([]);
  });
});

describe("check labels and banner", () => {
  it("labels", () => {
    expect(checkLabel({ input_check: { valid: true } }).label).toBe("Valid");
    expect(checkLabel({ input_check: null }).kind).toBe("none");
    expect(checkLabel({ input_check: { valid: false, message: "c005: plan is missing" } }).label).toBe("Missing plan");
    expect(checkLabel({ input_check: { valid: false, message: "must be number" } }).label).toBe("must be number");
  });
  it("banner uses the first reason", () => {
    const b = invalidBanner({
      cases_total: 24,
      invalid_total: 3,
      cases: [c({ input_check: { valid: false, message: "case c005: plan is missing." } })],
      findings: [],
    });
    expect(b).toEqual({
      title: "3 of 24 cases do not match the stage's input.",
      reason: "plan is missing",
      tail: "They are skipped in runs until fixed.",
    });
    expect(invalidBanner({ cases_total: 1, invalid_total: 0, cases: [], findings: [] })).toBeNull();
  });
});

describe("cell parsing", () => {
  it("strings stay strings, JSON values parse", () => {
    expect(parseCellText("hello", "old")).toEqual({ ok: true, value: "hello" });
    expect(parseCellText("", "old")).toEqual({ ok: true, value: undefined, omit: true });
    expect(parseCellText("", "old", true)).toEqual({ ok: true, value: "" });
    expect(parseCellText("[1,2]", [0])).toEqual({ ok: true, value: [1, 2] });
    expect(parseCellText("{nope", { a: 1 })).toEqual({ ok: false, error: "Not valid JSON" });
    expect(parseCellText("5", 3)).toEqual({ ok: true, value: 5 });
  });
  it("parses tags", () => {
    expect(parseTagsText("auth, api auth")).toEqual({ ok: true, tags: ["auth", "api"] });
    expect(parseTagsText("Bad").ok).toBe(false);
  });
});

describe("op building", () => {
  it("builds an update op without input_check", () => {
    const r = buildCellEditOp(c(), { kind: "input", name: "plan" }, "new plan", true);
    expect(r).toEqual({
      ok: true,
      op: {
        op: "update",
        id: "c001",
        case: {
          id: "c001",
          input: { diff: "+x", plan: "new plan", opts: { a: 1 } },
          expected: { findings: "f", severity: "low", extra: 1 },
          tags: ["auth"],
        },
      },
    });
  });
  it("returns null op when unchanged and error on bad JSON", () => {
    expect(buildCellEditOp(c(), { kind: "input", name: "plan" }, "p", false)).toEqual({ ok: true, op: null });
    expect(buildCellEditOp(c(), { kind: "input", name: "opts" }, "{", false)).toEqual({
      ok: false,
      error: "Not valid JSON",
    });
    const ok = buildCellEditOp(c(), { kind: "input", name: "opts" }, '{"a":2}', false);
    expect(ok.ok && ok.op?.op === "update" && ok.op.case.input.opts).toEqual({ a: 2 });
  });
  it("edits expected keys and tags", () => {
    const r = buildCellEditOp(c(), { kind: "expected", key: "findings" }, "g", false);
    expect(r.ok && r.op?.op === "update" && (r.op.case.expected as Record<string, unknown>).findings).toBe("g");
    expect(buildCellEditOp(c(), { kind: "tags" }, "auth api", false)).toEqual({
      ok: true,
      op: { op: "set_tags", id: "c001", tags: ["auth", "api"] },
    });
  });
});

describe("save state machine", () => {
  it("moves idle -> saving -> saved and sticks on conflict", () => {
    let s = saveReducer({ status: "idle" }, { type: "start" });
    expect(saveLabel(s)).toBe("Saving…");
    s = saveReducer(s, { type: "success" });
    expect(saveLabel(s)).toBe("Saved");
    s = saveReducer(s, { type: "conflict" });
    expect(saveLabel(s)).toBe("The file changed on disk. Reload.");
    expect(saveReducer(s, { type: "start" }).status).toBe("conflict");
    expect(saveReducer(s, { type: "reset" }).status).toBe("idle");
    expect(saveReducer(s, { type: "fail", message: "x" }).status).toBe("error");
  });
});

describe("add case", () => {
  it("next id continues after the highest cNNN", () => {
    expect(nextCaseId([])).toBe("c001");
    expect(nextCaseId(["c001", "c009", "custom"])).toBe("c010");
    expect(nextCaseId(["c999"])).toBe("c1000");
  });
  it("builds and validates", () => {
    const form = {
      id: "c003",
      title: "t",
      inputs: { diff: "+x", opts: '{"a":1}', plan: "" },
      expected: '["a"]',
      tags: "auth",
    };
    expect(buildAddCase(form, { existingIds: ["c001"], jsonFields: ["opts"] })).toEqual({
      ok: true,
      case: { id: "c003", title: "t", input: { diff: "+x", opts: { a: 1 } }, expected: ["a"], tags: ["auth"] },
    });
    const bad = buildAddCase(
      { ...form, id: "c001", expected: "{", inputs: { opts: "x" } },
      { existingIds: ["c001"], jsonFields: ["opts"] },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["expected", "id", "input.opts"]);
  });
});

describe("add case with unknown input fields", () => {
  it("parses the input JSON object", () => {
    const form = { id: "c001", title: "", inputs: {}, inputJson: '{"a":1}', expected: "", tags: "" };
    expect(buildAddCase(form, { existingIds: [] })).toEqual({ ok: true, case: { id: "c001", input: { a: 1 } } });
    const bad = buildAddCase({ ...form, inputJson: "[1]" }, { existingIds: [] });
    expect(bad.ok).toBe(false);
  });
});

describe("misc", () => {
  it("serializes jsonl without checks", () => {
    expect(serializeJsonl([c({ expected: undefined, tags: undefined, input: { a: 1 } })])).toBe(
      '{"id":"c001","input":{"a":1}}',
    );
  });
  it("rail meta", () => {
    expect(railMeta({ id: "x", cases: 24, used_by: ["a"] }).meta).toBe("24 cases · used by 1 eval");
    expect(railMeta({ id: "sample-review-diffs", cases: 8, used_by: [] })).toEqual({
      sample: true,
      note: "ships with Stageflow",
      meta: "8 cases",
    });
  });
  it("validates dataset names", () => {
    expect(validateDatasetName("", [])).not.toBeNull();
    expect(validateDatasetName("Bad Name", [])).not.toBeNull();
    expect(validateDatasetName("ok-name", ["ok-name"])).not.toBeNull();
    expect(validateDatasetName("ok-name", [])).toBeNull();
  });
});
