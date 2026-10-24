import { describe, expect, it } from "vitest";
import { applyUploadMapping } from "../src/config/datasetImport.js";

const schema = {
  type: "object",
  properties: {
    diff: { type: "string" },
    plan: { type: "string" },
    size: { type: "integer" },
    score: { type: "number" },
    strict: { type: "boolean" },
  },
  required: ["diff"],
};

describe("applyUploadMapping", () => {
  it("skips rows whose required field is empty, with the validator reason", () => {
    const res = applyUploadMapping(
      [{ d: "x" }, { d: "" }],
      { "input.diff": { column: "d" } },
      schema,
      [],
    );
    expect(res[0]).toMatchObject({ index: 0, status: "ready" });
    expect(res[1]!.status).toBe("skipped");
    expect(res[1]!.reason).toEqual(expect.any(String));
    expect(res[1]!.reason!.length).toBeLessThanOrEqual(160);
  });

  it("trims long reasons to 160 chars", () => {
    const longSchema = {
      type: "object",
      properties: { a: { type: "string", pattern: `^${"x".repeat(400)}$` } },
      required: ["a"],
    };
    const res = applyUploadMapping([{ a: "y" }], { "input.a": { column: "a" } }, longSchema, []);
    expect(res[0]!.status).toBe("skipped");
    expect(res[0]!.reason!.length).toBeLessThanOrEqual(160);
  });

  it("parses number, integer and boolean fields by schema type", () => {
    const [row] = applyUploadMapping(
      [{ d: "x", n: "7", f: "1.5", b: "TRUE" }],
      {
        "input.diff": { column: "d" },
        "input.size": { column: "n" },
        "input.score": { column: "f" },
        "input.strict": { column: "b" },
      },
      schema,
      [],
    );
    expect(row!.status).toBe("ready");
    expect(row!.case.input).toEqual({ diff: "x", size: 7, score: 1.5, strict: true });
  });

  it("skips a row whose cell does not parse", () => {
    const res = applyUploadMapping(
      [{ d: "x", n: "7.5" }, { d: "x", n: "abc" }, { d: "x", b: "maybe" }],
      {
        "input.diff": { column: "d" },
        "input.size": { column: "n" },
        "input.strict": { column: "b" },
      },
      schema,
      [],
    );
    expect(res.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(res[0]!.reason).toContain("size");
    expect(res[2]!.reason).toContain("strict");
  });

  it("splits cells into trimmed non-empty arrays", () => {
    const [row] = applyUploadMapping(
      [{ d: "x", e: " a ; b;;c " }],
      { "input.diff": { column: "d" }, "expected.findings": { column: "e", split: ";" } },
      schema,
      [],
    );
    expect(row!.case.expected).toEqual({ findings: ["a", "b", "c"] });
  });

  it("accepts expected keys that no schema or grader declared", () => {
    const [row] = applyUploadMapping(
      [{ d: "x", c: "bug", k: "a;b" }],
      { "input.diff": { column: "d" }, "expected.category": { column: "c" }, "expected.key_facts": { column: "k", split: ";" } },
      schema,
      [],
    );
    expect(row!.status).toBe("ready");
    expect(row!.case.expected).toEqual({ category: "bug", key_facts: ["a", "b"] });
  });

  it("continues ids after the highest cNNN and does not spend ids on skipped rows", () => {
    const res = applyUploadMapping(
      [{ d: "a" }, { d: "" }, { d: "b" }],
      { "input.diff": { column: "d" } },
      schema,
      ["c007", "c003", "custom-id"],
    );
    expect(res.filter((r) => r.status === "ready").map((r) => r.case.id)).toEqual(["c008", "c009"]);
  });

  it("starts at c001 when no ids exist", () => {
    const [row] = applyUploadMapping([{ d: "a" }], { "input.diff": { column: "d" } }, schema, []);
    expect(row!.case.id).toBe("c001");
  });

  it("ignores columns that are not mapped and honors null mapping", () => {
    const [row] = applyUploadMapping(
      [{ d: "x", p: "plan text", extra: "zzz" }],
      { "input.diff": { column: "d" }, "input.plan": null },
      schema,
      [],
    );
    expect(row!.case.input).toEqual({ diff: "x" });
  });

  it("ignores a mapped column missing from the row", () => {
    const [row] = applyUploadMapping(
      [{ d: "x" }],
      { "input.diff": { column: "d" }, "input.plan": { column: "nope" } },
      schema,
      [],
    );
    expect(row!.status).toBe("ready");
    expect(row!.case.input).toEqual({ diff: "x" });
  });

  it("makes every row ready when the stage has no schema", () => {
    const res = applyUploadMapping([{ d: "" }], { "input.diff": { column: "d" } }, undefined, []);
    expect(res[0]!.status).toBe("ready");
  });
});
