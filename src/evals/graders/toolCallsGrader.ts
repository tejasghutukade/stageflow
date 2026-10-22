import type { ConversationToolCall, FieldCheck, ResolvedGrader } from "../types.js";
import { describeCheck, runCheck } from "./fieldGrader.js";
import { notApplicable } from "./notApplicable.js";
import { isConversation, truncate } from "./subject.js";
import type { GradeCase, GradeData, GraderContext, Subject } from "./types.js";

type Check = { rule: string; passed: boolean; found: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectedList(testCase: GradeCase, key: "tools" | "forbidden_tools"): string[] | undefined {
  const expected = testCase.expected;
  if (!isRecord(expected)) return undefined;
  const list = expected[key];
  return Array.isArray(list) && list.every((x) => typeof x === "string") ? (list as string[]) : undefined;
}

export function toolNameMatches(pattern: string, name: string): boolean {
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return name === prefix || name.startsWith(`${prefix}.`);
  }
  return name === pattern;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function gradeToolCalls(
  grader: Extract<ResolvedGrader, { type: "tool_calls" }>,
  subject: Subject,
  testCase: GradeCase,
  _context?: GraderContext,
): GradeData {
  if (!isConversation(subject)) return notApplicable(grader, "envelope");
  const mustCall = grader.mustCall ?? expectedList(testCase, "tools");
  const mustNotCall = grader.mustNotCall ?? expectedList(testCase, "forbidden_tools");
  const { mustAskFirst, maxCalls } = grader;
  if (
    mustCall === undefined &&
    mustNotCall === undefined &&
    mustAskFirst === undefined &&
    maxCalls === undefined &&
    grader.args.length === 0
  ) {
    return {
      graderId: grader.id,
      graderType: "tool_calls",
      status: "error",
      errorCode: "EVAL_CASE_MISSING_EXPECTED",
      reason: "no tool rule: set a rule on the grader or expected.tools / expected.forbidden_tools on the case",
    };
  }
  const calls: readonly ConversationToolCall[] = subject.tool_calls;
  const named = (pattern: string) => calls.filter((c) => toolNameMatches(pattern, c.name));
  const checks: Check[] = [];

  for (const name of mustCall ?? []) {
    const n = named(name).length;
    checks.push({ rule: `must_call ${name}`, passed: n > 0, found: n > 0 ? plural(n, "call") : "not called" });
  }
  for (const name of mustNotCall ?? []) {
    const n = named(name).length;
    checks.push({ rule: `must_not_call ${name}`, passed: n === 0, found: n === 0 ? "not called" : plural(n, "call") });
  }
  for (const name of mustAskFirst ?? []) {
    const matching = named(name);
    const asked = matching.filter((c) => c.policy_outcome === "would_ask_first").length;
    checks.push({
      rule: `must_ask_first ${name}`,
      passed: asked > 0,
      found: asked > 0 ? plural(asked, "approval request") : matching.length > 0 ? "called without asking" : "not called",
    });
  }
  if (maxCalls !== undefined) {
    checks.push({
      rule: `max_calls ${maxCalls}`,
      passed: calls.length <= maxCalls,
      found: plural(calls.length, "call"),
    });
  }
  for (const arg of grader.args) {
    const check: FieldCheck = { path: arg.path, op: arg.op, ...(arg.value !== undefined ? { value: arg.value } : {}) };
    const matching = named(arg.tool);
    const rule = `args ${arg.tool} ${describeCheck(check)}`;
    let failure: string | undefined;
    for (const call of matching) {
      const outcome = runCheck(check, call.args);
      if (!outcome.passed) {
        failure = `call ${call.id}: ${outcome.found}`;
        break;
      }
    }
    checks.push({
      rule,
      passed: failure === undefined,
      found: failure ?? (matching.length === 0 ? "no call to check" : plural(matching.length, "call")),
    });
  }

  const first = checks.find((c) => !c.passed);
  const passed = first === undefined;
  return {
    graderId: grader.id,
    graderType: "tool_calls",
    status: "graded",
    passed,
    score: passed ? 1 : 0,
    rawValue: passed ? 1 : 0,
    ...(first ? { reason: truncate(`${first.rule}: ${first.found}`) } : {}),
    details: { checks: checks.map((c) => ({ ...c, found: truncate(c.found) })) },
  };
}
