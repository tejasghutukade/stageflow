import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { datasetContentHash } from "../src/config/datasetHash.js";
import { loadDatasetFile, parseDatasetText } from "../src/config/loadDataset.js";

const FIX = path.resolve(__dirname, "fixtures/datasets");
const load = (name: string, options = {}) => loadDatasetFile(path.join(FIX, name), options);
const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);

describe("dataset equivalence across formats", () => {
  it("loads the same 6 cases and hash from jsonl, json array, {cases} and csv", async () => {
    const results = await Promise.all([
      load("six.dataset.jsonl"),
      load("six.array.dataset.json"),
      load("six.cases.dataset.json"),
      load("six.dataset.csv"),
    ]);
    for (const r of results) expect(r.findings).toEqual([]);
    const [jsonl, ...rest] = results;
    expect(jsonl!.cases).toHaveLength(6);
    for (const r of rest) {
      expect(r.cases).toEqual(jsonl!.cases);
      expect(r.contentHash).toBe(jsonl!.contentHash);
    }
    expect(jsonl!.format).toBe("jsonl");
    expect(results[3]!.format).toBe("csv");
    expect(jsonl!.relPath).toBe("six.dataset.jsonl");
    expect(jsonl!.fileBytes).toBeGreaterThan(0);
  });

  it("parses CSV conventions: quotes, :json, tags split, omitted empty cells", async () => {
    const { cases } = await load("six.dataset.csv");
    expect(cases[1]!.input.diff).toBe('rename foo -> bar, with "quotes", and commas');
    expect(cases[0]!.input.files).toEqual(["auth.ts", "login.ts"]);
    expect(cases[2]!.tags).toEqual(["refactor", "docs"]);
    expect(cases[2]!.title).toBeUndefined();
    expect(cases[2]!.input.files).toBeUndefined();
    expect(cases[0]!.expected).toEqual({ verdict: "reject", findings: ["null-deref"] });
  });
});

describe("datasetContentHash", () => {
  const a = { id: "a", input: { x: "1", y: "2" } };
  const b = { id: "b", input: { x: "3" } };

  it("ignores key order and whitespace", () => {
    const reordered = { input: { y: "2", x: "1" }, id: "a" };
    expect(datasetContentHash([a, b])).toBe(datasetContentHash([reordered, b]));
    const text = '{ "id":"a", "input": {"x":"1","y":"2"} }\n\n{"id":"b","input":{"x":"3"}}';
    const compact = '{"id":"a","input":{"x":"1","y":"2"}}\n{"id":"b","input":{"x":"3"}}';
    expect(parseDatasetText(text, "jsonl").contentHash).toBe(
      parseDatasetText(compact, "jsonl").contentHash,
    );
  });

  it("changes when cases are reordered, edited, added or removed", () => {
    const base = datasetContentHash([a, b]);
    expect(datasetContentHash([b, a])).not.toBe(base);
    expect(datasetContentHash([a, { ...b, title: "t" }])).not.toBe(base);
    expect(datasetContentHash([a])).not.toBe(base);
    expect(datasetContentHash([a, b, b])).not.toBe(base);
  });
});

describe("validation codes", () => {
  it("dataset.load_error names the 1-based JSONL line", async () => {
    const r = await load("invalid-bad-line.dataset.jsonl");
    const f = r.findings.find((x) => x.code === "dataset.load_error")!;
    expect(f.severity).toBe("error");
    expect(f.line).toBe(2);
    expect(f.message).toContain("line 2");
    expect(r.cases.map((c) => c.id)).toEqual(["a"]);
  });

  it("dataset.load_error for an unreadable file and an unknown format", async () => {
    const missing = await load("nope.dataset.jsonl");
    expect(codes(missing)).toEqual(["dataset.load_error"]);
    const dir = await mkdtemp(path.join(tmpdir(), "ds-"));
    try {
      const file = path.join(dir, "x.dataset.txt");
      await writeFile(file, "{}");
      const r = await loadDatasetFile(file);
      expect(codes(r)).toEqual(["dataset.load_error"]);
      expect(r.findings[0]!.message).toContain(".txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dataset.load_error for bad CSV syntax and bad :json cells with the row", () => {
    const unterminated = parseDatasetText('id,input.x\na,"oops', "csv");
    expect(unterminated.findings[0]).toMatchObject({ code: "dataset.load_error", line: 2 });
    const badJson = parseDatasetText("id,input.x:json\na,{nope\n", "csv");
    expect(badJson.findings[0]).toMatchObject({ code: "dataset.load_error", line: 2 });
  });

  it("dataset.load_error for broken JSON", () => {
    expect(codes(parseDatasetText("{", "json"))).toEqual(["dataset.load_error"]);
  });

  it("dataset.empty", async () => {
    expect(codes(await load("invalid-empty.dataset.jsonl"))).toEqual(["dataset.empty"]);
  });

  it("dataset.not_object", async () => {
    const r = await load("invalid-not-object.dataset.jsonl");
    expect(codes(r)).toEqual(["dataset.not_object"]);
  });

  it("dataset.invalid_shape", async () => {
    expect(codes(await load("invalid-shape.dataset.json"))).toEqual(["dataset.invalid_shape"]);
  });

  it("dataset.unknown_key", async () => {
    const r = await load("invalid-unknown-key.dataset.jsonl");
    expect(r.findings[0]).toMatchObject({ code: "dataset.unknown_key", severity: "error" });
    expect(r.findings[0]!.message).toContain("extra");
  });

  it("dataset.case_missing_id for a hand-authored file without ids", async () => {
    const r = await load("invalid-missing-id.dataset.jsonl");
    expect(codes(r)).toEqual(["dataset.case_missing_id"]);
    expect(r.cases).toEqual([]);
  });

  it("dataset.case_invalid_id", async () => {
    expect(codes(await load("invalid-id.dataset.jsonl"))).toEqual(["dataset.case_invalid_id"]);
  });

  it("dataset.duplicate_id", async () => {
    const r = await load("invalid-duplicate-id.dataset.jsonl");
    expect(codes(r)).toEqual(["dataset.duplicate_id"]);
    expect(r.findings[0]!.line).toBe(2);
  });

  it("dataset.case_missing_input", async () => {
    expect(codes(await load("invalid-missing-input.dataset.jsonl"))).toEqual([
      "dataset.case_missing_input",
    ]);
  });

  it("dataset.invalid_field for tags, title, goal, metadata and input", async () => {
    expect(codes(await load("invalid-field.dataset.jsonl"))).toEqual(["dataset.invalid_field"]);
    const text = [
      '{"id":"a","input":[]}',
      `{"id":"b","input":{},"title":"${"t".repeat(121)}"}`,
      '{"id":"c","input":{},"goal":1}',
      '{"id":"d","input":{},"metadata":[]}',
      `{"id":"e","input":{},"tags":${JSON.stringify(Array.from({ length: 11 }, (_, i) => `t${i}`))}}`,
    ].join("\n");
    const r = parseDatasetText(text, "jsonl");
    expect(codes(r).filter((c) => c === "dataset.invalid_field")).toHaveLength(5);
  });

  it("dataset.csv_unknown_column names the header", async () => {
    const r = await load("invalid-csv-unknown-column.dataset.csv");
    const f = r.findings.find((x) => x.code === "dataset.csv_unknown_column")!;
    expect(f.message).toContain('"mystery"');
    expect(f.severity).toBe("error");
  });

  it("dataset.few_cases is a warning", async () => {
    const r = await load("few-cases.dataset.jsonl");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ code: "dataset.few_cases", severity: "warning" });
    expect(r.cases).toHaveLength(2);
  });

  it("dataset.too_many_cases with a small synthetic limit", () => {
    const text = [1, 2, 3, 4].map((n) => `{"id":"c${n}","input":{}}`).join("\n");
    const r = parseDatasetText(text, "jsonl", { limits: { maxCases: 3 } });
    expect(codes(r)).toContain("dataset.too_many_cases");
    expect(r.cases).toHaveLength(3);
  });

  it("dataset.case_too_large with a small synthetic limit", () => {
    const text = `{"id":"a","input":{"x":"${"y".repeat(200)}"}}\n{"id":"b","input":{}}`;
    const r = parseDatasetText(text, "jsonl", { limits: { maxCaseBytes: 100 } });
    expect(codes(r)).toContain("dataset.case_too_large");
    expect(r.cases.map((c) => c.id)).toEqual(["b"]);
  });

  it("dataset.file_too_large from text and from the file on disk", async () => {
    const text = '{"id":"a","input":{}}\n'.repeat(5);
    expect(codes(parseDatasetText(text, "jsonl", { limits: { maxFileBytes: 50 } }))).toEqual([
      "dataset.file_too_large",
    ]);
    const r = await load("six.dataset.jsonl", { limits: { maxFileBytes: 50 } });
    expect(codes(r)).toEqual(["dataset.file_too_large"]);
    expect(r.cases).toEqual([]);
  });

  it("findings carry category dataset and the file path", async () => {
    const r = await load("invalid-unknown-key.dataset.jsonl");
    expect(r.findings[0]).toMatchObject({
      category: "dataset",
      path: "invalid-unknown-key.dataset.jsonl",
    });
  });

  it("CSV supports a custom delimiter", () => {
    const r = parseDatasetText("id;input.x\na;1\nb;2\nc;3\nd;4\ne;5", "csv", {
      csvDelimiter: ";",
    });
    expect(r.findings).toEqual([]);
    expect(r.cases[0]).toEqual({ id: "a", input: { x: "1" } });
  });
});
