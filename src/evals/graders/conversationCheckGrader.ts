import type { ResolvedGrader } from "../types.js";
import { describeCheck, runCheck } from "./fieldGrader.js";
import { notApplicable } from "./notApplicable.js";
import { isConversation, subjectRoot, truncate } from "./subject.js";
import type { GradeData, GraderContext, Subject } from "./types.js";

export function countQuestions(text: string): number {
  const plain = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/https?:\/\/\S+/gi, " ");
  return (plain.match(/\?(?=\s|$)/g) ?? []).length;
}

type Check = { rule: string; passed: boolean; found: string; path?: string; op?: string };

export function gradeConversationCheck(
  grader: Extract<ResolvedGrader, { type: "conversation_check" }>,
  subject: Subject,
  _testCase: unknown,
  _context?: GraderContext,
): GradeData {
  if (!isConversation(subject)) return notApplicable(grader, "envelope");
  const checks: Check[] = [];

  if (grader.maxTurns !== undefined) {
    checks.push({
      rule: `max_turns ${grader.maxTurns}`,
      passed: subject.turns <= grader.maxTurns,
      found: `${subject.turns} turns`,
    });
  }

  if (grader.maxAgentQuestionsPerTurn !== undefined) {
    const limit = grader.maxAgentQuestionsPerTurn;
    const byTurn = new Map<number, string[]>();
    for (const m of subject.messages) {
      if (m.role === "assistant") byTurn.set(m.turn, [...(byTurn.get(m.turn) ?? []), m.text]);
    }
    let worst = { turn: 0, count: 0 };
    for (const [turn, texts] of byTurn) {
      const count = countQuestions(texts.join("\n"));
      if (count > worst.count) worst = { turn, count };
    }
    checks.push({
      rule: `max_agent_questions_per_turn ${limit}`,
      passed: worst.count <= limit,
      found: worst.count === 0 ? "no questions" : `${worst.count} in turn ${worst.turn}`,
    });
  }

  const root = subjectRoot(subject);
  for (const item of grader.finalReply) {
    const check = { path: "final_reply", op: item.op, ...(item.value !== undefined ? { value: item.value } : {}) };
    const outcome = runCheck(check, root);
    checks.push({
      rule: describeCheck(check),
      path: "final_reply",
      op: item.op,
      passed: outcome.passed,
      found: outcome.found,
    });
  }

  const first = checks.find((c) => !c.passed);
  const passed = first === undefined;
  return {
    graderId: grader.id,
    graderType: "conversation_check",
    status: "graded",
    passed,
    score: passed ? 1 : 0,
    rawValue: passed ? 1 : 0,
    ...(first ? { reason: truncate(`${first.rule}: found ${first.found}`) } : {}),
    details: { checks: checks.map((c) => ({ ...c, found: truncate(c.found) })) },
  };
}
