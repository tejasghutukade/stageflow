import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadEvalOutcome, parseEvalOutcome, evalFileStem } from "../src/config/loadEval.js";
import type { LoadIssue } from "../src/config/loadOutcome.js";
import { sha256Hex } from "../src/evals/canonical.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const EVALS_DIR = path.join(FIXTURES_ROOT, "evals");
const ROOT = FIXTURES_ROOT;

function fixturePath(name: string): string {
  return path.join(EVALS_DIR, `${name}.eval.yaml`);
}

async function codesFor(name: string): Promise<LoadIssue[]> {
  const outcome = await loadEvalOutcome(fixturePath(name), ROOT);
  return outcome.ok ? [] : outcome.issues;
}

const BASE = [
  "version: 1",
  "id: sample",
  "target:",
  "  kind: stage",
  "  file: ../stages/review.yaml",
  "dataset: ../datasets/sample.dataset.jsonl",
  "graders:",
  "  - id: output-schema",
  "    type: schema",
].join("\n");

function parseSample(yaml: string) {
  return parseEvalOutcome(yaml, path.join(EVALS_DIR, "sample.eval.yaml"), ROOT);
}

function issuesOf(yaml: string): LoadIssue[] {
  const outcome = parseSample(yaml);
  return outcome.ok ? [] : outcome.issues;
}

describe("loadEval: the schema doc example", () => {
  it("loads with no issues and yields 5 resolved graders with pinned hashes", async () => {
    const outcome = await loadEvalOutcome(fixturePath("valid"), ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.issues).toBeUndefined();
    const { value } = outcome;
    expect(value.id).toBe("valid");
    expect(value.relPath).toBe("evals/valid.eval.yaml");
    expect(value.graders.map((g) => [g.id, g.type, g.hash.slice(0, 6)])).toEqual([
      ["output-schema", "schema", "c9af7f"],
      ["findings-cite-lines", "field", "1da529"],
      ["finds-expected-issues", "reference", "5d7c42"],
      ["no-invented-files", "rubric", "e446c0"],
      ["clear-and-actionable", "rubric", "a60a5c"],
    ]);
  });

  it("computes fileHash from the file bytes", async () => {
    const outcome = await loadEvalOutcome(fixturePath("valid"), ROOT);
    if (!outcome.ok) throw new Error("expected load");
    const bytes = await readFile(fixturePath("valid"));
    expect(outcome.value.fileHash).toBe(sha256Hex(bytes));
  });

  it("fills defaults into resolved graders", async () => {
    const outcome = await loadEvalOutcome(fixturePath("valid"), ROOT);
    if (!outcome.ok) throw new Error("expected load");
    const [schema, field, reference, rubric, scored] = outcome.value.graders;
    expect(schema).toMatchObject({ weight: 1, mustPass: true });
    expect(field).toMatchObject({ weight: 1, mustPass: false });
    expect(reference).toMatchObject({ weight: 3, mode: "each_mentioned", passAt: 1, path: "payload.findings" });
    expect(rubric).toMatchObject({ scale: "pass_fail", judge: "anthropic/claude-sonnet-4-5", weight: 2 });
    expect(scored).toMatchObject({ scale: "1_to_5", passAt: 4, examples: [] });
  });

  it("hash is stable across key order and changes with the judge default", () => {
    const rubricYaml = (judgeLine: string, order: "a" | "b") =>
      [
        BASE.replace("graders:\n  - id: output-schema\n    type: schema", "graders:"),
        order === "a"
          ? "  - id: clear\n    type: rubric\n    rubric: Is it clear?\n    scale: pass_fail"
          : "  - scale: pass_fail\n    rubric: Is it clear?\n    type: rubric\n    id: clear",
        judgeLine,
      ].join("\n");
    const a = parseSample(rubricYaml("defaults:\n  judge: anthropic/a", "a"));
    const b = parseSample(rubricYaml("defaults:\n  judge: anthropic/a", "b"));
    const c = parseSample(rubricYaml("defaults:\n  judge: anthropic/c", "a"));
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected load");
    expect(a.value.graders[0]?.hash).toBe(b.value.graders[0]?.hash);
    expect(a.value.graders[0]?.hash).not.toBe(c.value.graders[0]?.hash);
  });
});

describe("loadEval: finding codes", () => {
  it("eval.load_error for unparseable YAML, with a position", async () => {
    const issues = await codesFor("load-error");
    expect(issues[0]?.code).toBe("eval.load_error");
    expect(issues[0]?.line).toBeGreaterThan(0);
  });

  it("eval.load_error when the file cannot be read", async () => {
    const outcome = await loadEvalOutcome(fixturePath("does-not-exist"), ROOT);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.issues[0]?.code).toBe("eval.load_error");
  });

  it("eval.not_object", async () => {
    expect((await codesFor("not-object")).map((i) => i.code)).toEqual(["eval.not_object"]);
  });

  it("eval.invalid_version", async () => {
    expect((await codesFor("invalid-version")).map((i) => i.code)).toEqual(["eval.invalid_version"]);
  });

  it("eval.unknown_key names the key", async () => {
    const issues = await codesFor("unknown-key");
    expect(issues.map((i) => i.code)).toEqual(["eval.unknown_key"]);
    expect(issues[0]?.message).toContain('"colour"');
  });

  it("eval.invalid_id", async () => {
    expect((await codesFor("invalid-id")).map((i) => i.code)).toContain("eval.invalid_id");
  });

  it("eval.id_filename_mismatch", async () => {
    const issues = await codesFor("id-filename-mismatch");
    expect(issues.map((i) => i.code)).toEqual(["eval.id_filename_mismatch"]);
    expect(issues[0]?.message).toContain("id-filename-mismatch");
  });

  it("eval.invalid_field names key and rule", async () => {
    const issues = await codesFor("invalid-field");
    expect(issues.map((i) => i.code)).toEqual(["eval.invalid_field"]);
    expect(issues[0]?.message).toContain('"repeats"');
    expect(issues[0]?.message).toContain("1 to 10");
  });

  it("eval.target_kind_unsupported", async () => {
    expect((await codesFor("target-kind-unsupported")).map((i) => i.code)).toEqual([
      "eval.target_kind_unsupported",
    ]);
  });

  it("eval.target_invalid when both forms are given", async () => {
    expect((await codesFor("target-invalid")).map((i) => i.code)).toEqual(["eval.target_invalid"]);
  });

  it("eval.target_invalid when the pipeline form lacks a stage, or nothing is given", () => {
    const noStage = BASE.replace("  file: ../stages/review.yaml", "  pipeline: ../pipelines/a.pipeline.yaml");
    expect(issuesOf(noStage).map((i) => i.code)).toEqual(["eval.target_invalid"]);
    const none = BASE.replace("  file: ../stages/review.yaml\n", "");
    expect(issuesOf(none).map((i) => i.code)).toEqual(["eval.target_invalid"]);
  });

  it("eval.grader_duplicate_id", async () => {
    expect((await codesFor("grader-duplicate-id")).map((i) => i.code)).toEqual([
      "eval.grader_duplicate_id",
    ]);
  });

  it("eval.grader_invalid", async () => {
    expect((await codesFor("grader-invalid")).map((i) => i.code)).toEqual(["eval.grader_invalid"]);
  });

  it("a command grader is rejected as not available in release 1", async () => {
    const issues = await codesFor("grader-type-unsupported");
    expect(issues.map((i) => i.code)).toEqual(["eval.grader_type_unsupported"]);
    expect(issues[0]?.message).toContain("not available in release 1");
  });

  it("any other unknown grader type is unsupported", () => {
    const yaml = BASE.replace("type: schema", "type: vibes");
    const issues = issuesOf(yaml);
    expect(issues.map((i) => i.code)).toEqual(["eval.grader_type_unsupported"]);
    expect(issues[0]?.message).toContain("vibes");
  });
});

describe("loadEval: unknown keys at every level", () => {
  it("top level", () => {
    const issues = issuesOf(`${BASE}\nextra: 1`);
    expect(issues.map((i) => [i.code, i.message.includes('"extra"')])).toEqual([["eval.unknown_key", true]]);
  });

  it("target", () => {
    const issues = issuesOf(BASE.replace("  file: ../stages/review.yaml", "  file: ../stages/review.yaml\n  revision: 2"));
    expect(issues.map((i) => i.code)).toEqual(["eval.unknown_key"]);
    expect(issues[0]?.message).toContain('"revision"');
  });

  it("defaults", () => {
    const issues = issuesOf(`${BASE}\ndefaults:\n  temperature: 0`);
    expect(issues.map((i) => i.code)).toEqual(["eval.unknown_key"]);
    expect(issues[0]?.message).toContain('"temperature"');
  });

  it("a grader", () => {
    const issues = issuesOf(BASE.replace("    type: schema", "    type: schema\n    colour: red"));
    expect(issues.map((i) => i.code)).toEqual(["eval.unknown_key"]);
    expect(issues[0]?.message).toContain('"colour"');
  });

  it("a checks item", () => {
    const yaml = BASE.replace(
      "  - id: output-schema\n    type: schema",
      "  - id: f\n    type: field\n    checks:\n      - { path: payload.a, op: exists, nope: 1 }",
    );
    const issues = issuesOf(yaml);
    expect(issues.map((i) => i.code)).toEqual(["eval.unknown_key"]);
    expect(issues[0]?.message).toContain('"nope"');
  });

  it("task, budget and rubric examples", () => {
    expect(issuesOf(`${BASE}\ntask:\n  goal: x\n  extra: y`).map((i) => i.code)).toEqual(["eval.unknown_key"]);
    expect(issuesOf(`${BASE}\nbudget:\n  tokens: 3`).map((i) => i.code)).toEqual(["eval.unknown_key"]);
    const rubric = BASE.replace(
      "  - id: output-schema\n    type: schema",
      "  - id: r\n    type: rubric\n    rubric: x\n    judge: a/b\n    examples:\n      - { verdict: pass, output: o, extra: 1 }",
    );
    expect(issuesOf(rubric).map((i) => i.code)).toEqual(["eval.unknown_key"]);
  });
});

describe("loadEval: id, target and paths", () => {
  it("evalFileStem strips .eval.yaml", () => {
    expect(evalFileStem("/x/review-findings.eval.yaml")).toBe("review-findings");
    expect(evalFileStem("/x/other.yaml")).toBe("other");
  });

  it("a dataset path escaping the project root is eval.dataset_unresolved", () => {
    const yaml = BASE.replace("../datasets/sample.dataset.jsonl", "../../../../outside.dataset.jsonl");
    expect(issuesOf(yaml).map((i) => i.code)).toEqual(["eval.dataset_unresolved"]);
  });

  it("a target path escaping the project root is eval.target_unresolved", () => {
    const yaml = BASE.replace("../stages/review.yaml", "../../../../outside/stage.yaml");
    expect(issuesOf(yaml).map((i) => i.code)).toEqual(["eval.target_unresolved"]);
  });

  it("missing required keys are eval.invalid_field", () => {
    const issues = issuesOf("version: 1\nid: sample\n");
    expect(issues.map((i) => i.code)).toEqual([
      "eval.invalid_field",
      "eval.invalid_field",
      "eval.invalid_field",
    ]);
  });
});

describe("loadEval: grader rules", () => {
  const withGrader = (grader: string) =>
    BASE.replace("  - id: output-schema\n    type: schema", grader);

  it("schema grader takes no extra keys", () => {
    expect(issuesOf(withGrader("  - id: s\n    type: schema\n    checks: []")).map((i) => i.code)).toEqual([
      "eval.unknown_key",
    ]);
  });

  it("weight must be positive; must_pass boolean; description length", () => {
    const codes = (g: string) => issuesOf(withGrader(g)).map((i) => i.code);
    expect(codes("  - id: s\n    type: schema\n    weight: 0")).toEqual(["eval.invalid_field"]);
    expect(codes("  - id: s\n    type: schema\n    must_pass: yes please")).toEqual(["eval.invalid_field"]);
    expect(codes(`  - id: s\n    type: schema\n    description: ${"x".repeat(201)}`)).toEqual([
      "eval.invalid_field",
    ]);
  });

  it("field ops validate their values", () => {
    const check = (c: string) =>
      issuesOf(withGrader(`  - id: f\n    type: field\n    checks:\n      - ${c}`)).map((i) => i.code);
    expect(check("{ path: payload.a, op: exists }")).toEqual([]);
    expect(check("{ path: payload.a, op: exists, value: 1 }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: payload.a, op: equals }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: payload.a, op: gte, value: x }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: payload.a, op: between, value: [5, 1] }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: payload.a, op: between, value: [1, 5] }")).toEqual([]);
    expect(check("{ path: payload.a, op: matches, value: '(' }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: payload.a, op: in, value: 3 }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: payload.a, op: length_gte, value: 1.5 }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: payload.a, op: nope }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: 'payload..a', op: exists }")).toEqual(["eval.grader_invalid"]);
    expect(check("{ path: 'payload.items[*].line', op: exists }")).toEqual([]);
    expect(check("{ path: 'payload.items[2]', op: exists }")).toEqual([]);
  });

  it("reference needs mode and expected; pass_at in 0-1", () => {
    const codes = (g: string) => issuesOf(withGrader(g)).map((i) => i.code);
    expect(codes("  - id: r\n    type: reference\n    mode: equals\n    expected: expected.x")).toEqual([]);
    expect(codes("  - id: r\n    type: reference\n    expected: expected.x")).toEqual(["eval.grader_invalid"]);
    expect(codes("  - id: r\n    type: reference\n    mode: equals")).toEqual(["eval.grader_invalid"]);
    expect(
      codes("  - id: r\n    type: reference\n    mode: equals\n    expected: expected.x\n    pass_at: 2"),
    ).toEqual(["eval.grader_invalid"]);
  });

  it("rubric rules: length, pass_at only with 1_to_5, examples shape and count", () => {
    const codes = (g: string) => issuesOf(withGrader(g)).map((i) => i.code);
    const head = "  - id: r\n    type: rubric\n    judge: a/b\n";
    expect(codes(`${head}    rubric: ok`)).toEqual([]);
    expect(codes(`${head}    rubric: ''`)).toEqual(["eval.grader_invalid"]);
    expect(codes(`${head}    rubric: ${"x".repeat(4001)}`)).toEqual(["eval.grader_invalid"]);
    expect(codes(`${head}    rubric: ok\n    pass_at: 3`)).toEqual(["eval.grader_invalid"]);
    expect(codes(`${head}    rubric: ok\n    scale: 1_to_5\n    pass_at: 6`)).toEqual(["eval.grader_invalid"]);
    expect(codes(`${head}    rubric: ok\n    scale: 1_to_5\n    examples:\n      - { score: 5, output: o }`)).toEqual([]);
    expect(codes(`${head}    rubric: ok\n    examples:\n      - { score: 5, output: o }`)).toEqual([
      "eval.unknown_key",
      "eval.grader_invalid",
    ]);
    const seven = Array.from({ length: 7 }, () => "      - { verdict: pass, output: o }").join("\n");
    expect(codes(`${head}    rubric: ok\n    examples:\n${seven}`)).toEqual(["eval.grader_invalid"]);
  });

  it("code needs a body", () => {
    const codes = (g: string) => issuesOf(withGrader(g)).map((i) => i.code);
    expect(codes("  - id: c\n    type: code\n    code: return true;")).toEqual([]);
    expect(codes("  - id: c\n    type: code")).toEqual(["eval.grader_invalid"]);
  });

  it("graders must hold 1-20 items", () => {
    expect(issuesOf(BASE.replace(/graders:[\s\S]*$/, "graders: []")).map((i) => i.code)).toEqual([
      "eval.invalid_field",
    ]);
  });
});

describe("loadEval: defaults and budget ranges", () => {
  const codes = (extra: string) => issuesOf(`${BASE}\n${extra}`).map((i) => i.code);

  it("accepts the documented ranges", () => {
    expect(
      codes("defaults:\n  repeats: 10\n  concurrency: 8\n  pass_threshold: 1\n  max_cost_usd: 0.5\nbudget:\n  latency_ms: 1\n  cost_usd: 0.01"),
    ).toEqual([]);
  });

  it("rejects out-of-range values", () => {
    expect(codes("defaults:\n  repeats: 0")).toEqual(["eval.invalid_field"]);
    expect(codes("defaults:\n  concurrency: 9")).toEqual(["eval.invalid_field"]);
    expect(codes("defaults:\n  pass_threshold: 0")).toEqual(["eval.invalid_field"]);
    expect(codes("defaults:\n  pass_threshold: 1.1")).toEqual(["eval.invalid_field"]);
    expect(codes("defaults:\n  max_cost_usd: 0")).toEqual(["eval.invalid_field"]);
    expect(codes("budget:\n  latency_ms: -1")).toEqual(["eval.invalid_field"]);
    expect(codes("type: sometimes")).toEqual(["eval.invalid_field"]);
    expect(codes("name: ''")).toEqual(["eval.invalid_field"]);
  });
});
