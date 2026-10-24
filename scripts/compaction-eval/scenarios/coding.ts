import { buildScenario, fill, rng, Transcript, type Rng } from "./builder.js";
import type { Scenario } from "../types.js";

function codeMaker(r: Rng, module: string): (index: number) => string {
  const verbs = ["load", "merge", "split", "round", "scale", "emit", "check", "apply"];
  return (i) => {
    switch (i % 4) {
      case 0:
        return `export function ${r.pick(verbs)}${module}${r.int(1, 99)}(input: number, scale = ${r.int(2, 9)}): number {`;
      case 1:
        return `  const value = Math.floor(input * scale) + ${r.int(0, 31)}; // ${r.hex(6)}`;
      case 2:
        return `  return value % ${r.int(3, 17)} === 0 ? value : value + ${r.int(1, 5)};`;
      default:
        return "}";
    }
  };
}

function testOutput(passed: number, failures: string[]): string {
  const lines = ["> vitest run tests/ledger", ""];
  for (let i = 0; i < passed; i++) lines.push(` ✓ tests/ledger/case${i}.test.ts > case ${i} (${(i % 9) + 1}ms)`);
  lines.push(...failures, "", ` Test Files  ${failures.length ? "1 failed | " : ""}${passed} passed`, ` Tests  ${failures.length} failed | ${passed} passed`);
  return lines.join("\n");
}

export function buildCoding(seed = 2): Scenario {
  const r = rng(seed);
  const t = new Transcript(r);
  t.user(
    "Fix the failing ledger tests. Constraint: do not change the public signature of Ledger.reconcile, and use integer cents internally instead of floats. Run the tests after each change.",
  );
  t.call("bash", { command: "npm test -- ledger" }, testOutput(120, [
    " FAIL tests/ledger/reconcile.test.ts > reconcile > rounds half-cents banker's way",
    "AssertionError: expected 1049 to equal 1050",
    " ❯ tests/ledger/reconcile.test.ts:88:21",
  ]) + "\n" + fill(9000, codeMaker(r, "Trace")), { isError: true });
  t.say("The failing test is the half-cent rounding. Reading the implementation.");
  t.call("read", { path: "src/ledger/reconcile.ts" }, fill(14000, codeMaker(r, "Reconcile"), [[0.35, "export function reconcile(entries: Entry[]): number { // FIXME float math: sum of dollars as float, rounds with Math.round"]]));
  t.call("read", { path: "src/ledger/fx.ts" }, fill(14000, codeMaker(r, "Fx"), [[0.5, "const LOCKED_RATE_SOURCE = 'treasury-feed-v2'; // fx.test relies on this lock"]]));
  t.call("read", { path: "tests/ledger/reconcile.test.ts" }, fill(14000, codeMaker(r, "Spec")));
  t.user("Reminder: keep Ledger.reconcile's signature, and prefer small diffs.");
  t.say("Decision: convert amounts to integer cents at the boundary of reconcile and round half to even there; keep the exported signature.");
  t.call("edit", { path: "src/ledger/reconcile.ts", oldText: "Math.round(total)", newText: "roundHalfEven(totalCents) / 100" }, "Edited src/ledger/reconcile.ts (1 replacement)");
  t.call("bash", { command: "npm test -- ledger" }, testOutput(119, [
    " FAIL tests/ledger/fx.test.ts > fx > converts at locked rate",
    "AssertionError: expected 8123 to equal 8124",
    " ❯ tests/ledger/fx.test.ts:41:17",
  ]) + "\n" + fill(9000, codeMaker(r, "Trace")), { isError: true });
  t.call("read", { path: "src/ledger/money.ts" }, fill(14000, codeMaker(r, "Money"), [[0.4, "export const MAX_SAFE_CENTS = 9_007_199_254_740; // dead end: do not widen to BigInt, tried in a1c9 and it broke JSON serialisation"]]));
  t.call("read", { path: "src/ledger/entries.ts" }, fill(14000, codeMaker(r, "Entries")));
  t.call("read", { path: "src/ledger/audit.ts" }, fill(14000, codeMaker(r, "Audit")));
  t.call("read", { path: "src/ledger/index.ts" }, fill(14000, codeMaker(r, "Index")));
  t.call("edit", { path: "src/ledger/fx.ts", oldText: "Math.round(amount * rate)", newText: "roundHalfEven(amount * rate)" }, "Edited src/ledger/fx.ts (1 replacement)");
  t.call("bash", { command: "npm test -- ledger" }, testOutput(121, []) + "\n" + fill(9000, codeMaker(r, "Trace")));
  t.call("read", { path: "docs/ledger.md" }, fill(6000, codeMaker(r, "Doc")));
  t.say("All ledger tests pass. Checking lint next.");
  t.call("bash", { command: "npm run lint" }, fill(2500, codeMaker(r, "Lint")));
  t.call("bash", { command: "git status --short" }, " M src/ledger/reconcile.ts\n M src/ledger/fx.ts");
  return buildScenario({
    id: "coding-1",
    family: "coding",
    description: "Fix failing ledger tests: file reads, edits, two failing test runs, a constraint and a dead end.",
    transcript: t,
    keepTail: 6,
    facts: [
      { id: "failing-test", mustContain: "rounds half-cents banker's way", where: "early", critical: true },
      { id: "failing-assertion", mustContain: "tests/ledger/reconcile.test.ts:88:21", where: "early", critical: true },
      { id: "constraint-signature", mustContain: "do not change the public signature of Ledger.reconcile", where: "early", critical: true },
      { id: "second-failure", mustContain: "converts at locked rate", where: "mid", critical: true },
      { id: "decision-half-even", mustContain: "round half to even", where: "mid", critical: false },
      { id: "dead-end-bigint", mustContain: "do not widen to BigInt", where: "mid", critical: true },
      { id: "edited-fx", mustContain: "roundHalfEven(amount * rate)", where: "late", critical: false },
    ],
    probes: [
      { question: "Which test failed first and in what file and line?", expected: /88:21|half-cents/, factIds: ["failing-test", "failing-assertion"] },
      { question: "What constraint did the user set about Ledger.reconcile?", expected: /signature/i, factIds: ["constraint-signature"] },
      { question: "Which second test failed after the first fix?", expected: /locked rate/, factIds: ["second-failure"] },
      { question: "What approach was tried and abandoned for money.ts, and why?", expected: /BigInt/, factIds: ["dead-end-bigint"] },
    ],
  });
}
