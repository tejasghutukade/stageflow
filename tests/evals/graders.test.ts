import { describe, expect, it } from "vitest";
import { gradeDeterministic } from "../../src/evals/graders/index.js";
import { evaluatePath, parsePath, resolveValue } from "../../src/evals/graders/path.js";
import type { GraderContext, Subject } from "../../src/evals/graders/types.js";
import type { FieldCheck, PlanCase, ResolvedGrader } from "../../src/evals/types.js";

const ctx: GraderContext = { evalId: "e", runId: "er_1", repeat: 0, passThreshold: 0.8 };
const tc = (extra: Partial<PlanCase> = {}): PlanCase => ({
  id: "c1",
  position: 0,
  input: {},
  tags: [],
  ...extra,
});
const subj = (payload?: Record<string, unknown>, extra: Partial<Subject> = {}): Subject => ({
  status: "success",
  summary: "ok",
  payload,
  artifacts: [],
  ...extra,
});
const common = { id: "g", weight: 1, mustPass: false, hash: "abc123" };

const field = (checks: FieldCheck[]) =>
  ({ ...common, type: "field", checks }) as Extract<ResolvedGrader, { type: "field" }>;
const runField = (check: FieldCheck, s: Subject) =>
  gradeDeterministic(field([check]), s, tc(), ctx);

describe("path", () => {
  const env = {
    status: "success",
    payload: { findings: [{ file: "a", line: 1 }, { file: "b" }], tags: ["x"], n: { deep: 3 } },
  };
  it("dots and indexes", () => {
    expect(resolveValue(env, "payload.n.deep")).toEqual({ found: true, value: 3 });
    expect(resolveValue(env, "payload.findings[0].file")).toEqual({ found: true, value: "a" });
    expect(resolveValue(env, "payload.findings[5]").found).toBe(false);
    expect(resolveValue(env, "payload.nope").found).toBe(false);
  });
  it("wildcard returns each node and marks missing branches", () => {
    const r = evaluatePath(env, "payload.findings[*].line");
    expect(r.wildcard).toBe(true);
    expect(r.nodes).toEqual([{ found: true, value: 1 }, { found: false }]);
    expect(r.resolved).toBe(false);
    expect(evaluatePath(env, "payload.findings[*].file").resolved).toBe(true);
  });
  it("empty wildcard", () => {
    const r = evaluatePath({ payload: { findings: [] } }, "payload.findings[*].line");
    expect(r.nodes).toEqual([]);
    expect(r.emptyWildcard).toBe(true);
  });
  it("wildcard on a non-array is unresolved", () => {
    expect(evaluatePath(env, "payload.n[*]").resolved).toBe(false);
  });
  it("parse rejects junk", () => {
    expect(parsePath("a..b")).toBeUndefined();
    expect(parsePath("a[x]")).toBeUndefined();
    expect(parsePath("payload.findings[*].line")).toHaveLength(4);
  });
  it("case path", () => {
    expect(resolveValue(tc({ expected: { findings: ["x"] } }), "expected.findings").value).toEqual(["x"]);
  });
});

describe("field grader ops", () => {
  const p = { s: "hello world", n: 5, arr: [1, 2, 3], obj: { a: 1 }, empty: "", ea: [], eo: {}, nul: null };
  const cases: Array<[FieldCheck, boolean, FieldCheck]> = [
    [{ path: "payload.s", op: "exists" }, true, { path: "payload.missing", op: "exists" }],
    [{ path: "payload.s", op: "not_empty" }, true, { path: "payload.empty", op: "not_empty" }],
    [{ path: "payload.arr", op: "not_empty" }, true, { path: "payload.ea", op: "not_empty" }],
    [{ path: "payload.obj", op: "not_empty" }, true, { path: "payload.eo", op: "not_empty" }],
    [{ path: "payload.n", op: "equals", value: 5 }, true, { path: "payload.n", op: "equals", value: 6 }],
    [{ path: "payload.obj", op: "equals", value: { a: 1 } }, true, { path: "payload.obj", op: "equals", value: { a: 2 } }],
    [{ path: "payload.n", op: "not_equals", value: 6 }, true, { path: "payload.n", op: "not_equals", value: 5 }],
    [{ path: "payload.s", op: "contains", value: "lo wo" }, true, { path: "payload.s", op: "contains", value: "LO" }],
    [{ path: "payload.arr", op: "contains", value: 2 }, true, { path: "payload.arr", op: "contains", value: 9 }],
    [{ path: "payload.s", op: "matches", value: "^hello" }, true, { path: "payload.s", op: "matches", value: "^world" }],
    [{ path: "payload.n", op: "gte", value: 5 }, true, { path: "payload.n", op: "gte", value: 6 }],
    [{ path: "payload.n", op: "lte", value: 5 }, true, { path: "payload.n", op: "lte", value: 4 }],
    [{ path: "payload.n", op: "between", value: [1, 5] }, true, { path: "payload.n", op: "between", value: [6, 9] }],
    [{ path: "payload.n", op: "in", value: [4, 5] }, true, { path: "payload.n", op: "in", value: [1, 2] }],
    [{ path: "payload.arr", op: "length_gte", value: 3 }, true, { path: "payload.arr", op: "length_gte", value: 4 }],
    [{ path: "payload.s", op: "length_lte", value: 11 }, true, { path: "payload.s", op: "length_lte", value: 3 }],
  ];
  for (const [pass, , fail] of cases) {
    it(`${pass.op}: passes and fails`, () => {
      const a = runField(pass, subj(p));
      expect(a.passed).toBe(true);
      expect(a.score).toBe(1);
      const b = runField(fail, subj(p));
      expect(b.passed).toBe(false);
      expect(b.score).toBe(0);
      expect(b.reason).toContain(fail.path);
      expect(b.reason).toContain(fail.op);
    });
  }

  it("null does not exist; other-type comparisons fail", () => {
    expect(runField({ path: "payload.nul", op: "exists" }, subj(p)).passed).toBe(false);
    expect(runField({ path: "payload.s", op: "gte", value: 1 }, subj(p)).passed).toBe(false);
    expect(runField({ path: "payload.n", op: "length_gte", value: 1 }, subj(p)).passed).toBe(false);
  });

  it("[*]: all must satisfy", () => {
    const s = subj({ f: [{ line: 1 }, { line: 2 }] });
    expect(runField({ path: "payload.f[*].line", op: "gte", value: 1 }, s).passed).toBe(true);
    expect(runField({ path: "payload.f[*].line", op: "gte", value: 2 }, s).passed).toBe(false);
    const missing = subj({ f: [{ line: 1 }, {}] });
    expect(runField({ path: "payload.f[*].line", op: "exists" }, missing).passed).toBe(false);
  });

  it("[*] with no match fails ops, length_* sees the empty array", () => {
    const s = subj({ f: [] });
    for (const op of ["exists", "not_empty"] as const) {
      expect(runField({ path: "payload.f[*].line", op }, s).passed).toBe(false);
    }
    expect(runField({ path: "payload.f[*].line", op: "gte", value: 0 }, s).passed).toBe(false);
    expect(runField({ path: "payload.f[*].line", op: "length_lte", value: 0 }, s).passed).toBe(true);
    expect(runField({ path: "payload.f[*].line", op: "length_gte", value: 1 }, s).passed).toBe(false);
  });

  it("envelope fields and details.checks", () => {
    const g = field([
      { path: "status", op: "equals", value: "success" },
      { path: "payload.n", op: "gte", value: 9 },
    ]);
    const r = gradeDeterministic(g, subj(p), tc(), ctx);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("payload.n gte 9: found 5");
    expect(r.details).toEqual({
      checks: [
        { path: "status", op: "equals", passed: true, found: '"success"' },
        { path: "payload.n", op: "gte", passed: false, found: "5" },
      ],
    });
  });

  it("truncates reason to 200 chars", () => {
    const r = runField({ path: "payload.s", op: "equals", value: "x" }, subj({ s: "y".repeat(500) }));
    expect(r.reason!.length).toBeLessThanOrEqual(200);
  });
});

describe("reference grader", () => {
  const ref = (over: Record<string, unknown> = {}) =>
    ({
      ...common,
      type: "reference",
      mode: "each_mentioned",
      path: "payload.findings",
      expected: "expected.findings",
      passAt: 1,
      ...over,
    }) as Extract<ResolvedGrader, { type: "reference" }>;
  const run = (g: ReturnType<typeof ref>, s: Subject, c: PlanCase) => gradeDeterministic(g, s, c, ctx);

  it("case-insensitive, whitespace collapsed", () => {
    const s = subj({ findings: "Null   pointer\n in AUTH" });
    const r = run(ref(), s, tc({ expected: { findings: ["null pointer in auth"] } }));
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.details).toEqual({ items: [{ text: "null pointer in auth", found: true }] });
  });
  it("1 of 2 scores 0.5 and fails at pass_at 1, passes at 0.5", () => {
    const s = subj({ findings: ["sql injection"] });
    const c = tc({ expected: { findings: ["sql injection", "xss"] } });
    const r = run(ref(), s, c);
    expect(r.score).toBe(0.5);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("xss");
    expect(run(ref({ passAt: 0.5 }), s, c).passed).toBe(true);
  });
  it("empty expected scores 1", () => {
    const r = run(ref(), subj({ findings: [] }), tc({ expected: { findings: [] } }));
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });
  it("non-string actual is serialized", () => {
    const s = subj({ findings: [{ file: "auth.ts", line: 42 }] });
    const r = run(ref(), s, tc({ expected: { findings: ['"line":42'] } }));
    expect(r.score).toBe(1);
  });
  it("missing actual finds nothing", () => {
    const r = run(ref({ path: "payload.nope" }), subj({}), tc({ expected: { findings: ["a"] } }));
    expect(r.status).toBe("graded");
    expect(r.score).toBe(0);
  });
  it("equals uses deep equality", () => {
    const g = ref({ mode: "equals", path: "payload", expected: "expected" });
    expect(run(g, subj({ a: [1, { b: 2 }] }), tc({ expected: { a: [1, { b: 2 }] } })).passed).toBe(true);
    const bad = run(g, subj({ a: 1 }), tc({ expected: { a: 2 } }));
    expect(bad.passed).toBe(false);
    expect(bad.score).toBe(0);
  });
  it("missing expected is an error grade", () => {
    const r = run(ref(), subj({ findings: [] }), tc());
    expect(r.status).toBe("error");
    expect(r.errorCode).toBe("EVAL_CASE_MISSING_EXPECTED");
    expect(r.passed).toBeUndefined();
    const eq = run(ref({ mode: "equals", expected: "expected" }), subj({}), tc());
    expect(eq.errorCode).toBe("EVAL_CASE_MISSING_EXPECTED");
  });
  it("each_mentioned with a non-string-array expected is an error grade", () => {
    const r = run(ref(), subj({ findings: [] }), tc({ expected: { findings: "text" } }));
    expect(r.status).toBe("error");
  });
});

describe("schema grader", () => {
  const g = { ...common, type: "schema" } as Extract<ResolvedGrader, { type: "schema" }>;
  const outputSchema = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  };
  const c = { ...ctx, outputSchema };
  it("passes a valid payload", () => {
    const r = gradeDeterministic(g, subj({ count: 2 }), tc(), c);
    expect(r).toMatchObject({ status: "graded", passed: true, score: 1 });
  });
  it("fails an invalid payload with the validator message", () => {
    const r = gradeDeterministic(g, subj({ count: "x" }), tc(), c);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reason).toBeTruthy();
  });
  it("fails a failure envelope", () => {
    const r = gradeDeterministic(g, subj({ count: 2 }, { status: "failure" }), tc(), c);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("failure");
  });
});

describe("code grader", () => {
  const code = (body: string) =>
    ({ ...common, type: "code", code: body }) as Extract<ResolvedGrader, { type: "code" }>;
  const run = (body: string, c: GraderContext = ctx) =>
    gradeDeterministic(code(body), subj({ n: 1 }), tc({ id: "case-x" }), c);

  it("boolean", () => {
    expect(run("return output.payload.n === 1")).toMatchObject({ passed: true, score: 1 });
    expect(run("return false")).toMatchObject({ status: "graded", passed: false, score: 0 });
  });
  it("number passes at pass_threshold", () => {
    expect(run("return 0.9")).toMatchObject({ passed: true, score: 0.9 });
    expect(run("return 0.5")).toMatchObject({ passed: false, score: 0.5 });
  });
  it("object", () => {
    expect(run("return { pass: true, score: 0.7, reason: 'fine' }")).toMatchObject({
      passed: true,
      score: 0.7,
      reason: "fine",
    });
    expect(run("return { pass: false }")).toMatchObject({ passed: false, score: 0 });
  });
  it("receives output, testCase and context", () => {
    const r = run("return testCase.id === 'case-x' && context.evalId === 'e' && context.repeat === 0 && output.status === 'success'");
    expect(r.passed).toBe(true);
  });
  it("thrown error and bad returns are error grades", () => {
    for (const body of ["throw new Error('boom')", "return 'yes'", "return 2", "return undefined", "return { score: 1 }", "return null"]) {
      const r = run(body);
      expect(r.status, body).toBe("error");
      expect(r.errorCode).toBe("EVAL_GRADER_CODE_ERROR");
    }
    expect(run("throw new Error('boom')").reason).toContain("boom");
  });
  it("syntax error is an error grade", () => {
    expect(run("return (")).toMatchObject({ status: "error", errorCode: "EVAL_GRADER_CODE_ERROR" });
  });
  it("infinite loop hits the timeout", () => {
    const r = run("while (true) {}", { ...ctx, codeTimeoutMs: 100 });
    expect(r).toMatchObject({ status: "error", errorCode: "EVAL_GRADER_CODE_ERROR" });
    expect(r.reason).toContain("timed out");
  });
  it("process, require and fetch are undefined", () => {
    const r = run("return typeof process === 'undefined' && typeof require === 'undefined' && typeof fetch === 'undefined' && typeof globalThis.process === 'undefined'");
    expect(r.passed).toBe(true);
  });
  it("arguments are frozen", () => {
    const r = run(
      "'use strict'; let ok = 0; for (const o of [output, output.payload, testCase, testCase.input, context]) { try { o.x = 1; } catch { ok++; } } return ok === 5",
    );
    expect(r.passed).toBe(true);
  });
  it("cannot mutate the caller's data", () => {
    const s = subj({ n: 1 });
    gradeDeterministic(code("output.payload.n = 2; return true"), s, tc(), ctx);
    expect(s.payload).toEqual({ n: 1 });
  });
});
