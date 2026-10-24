import { matchesText, messageText } from "./scenarios/builder.js";
import type { EvalModel, FactPosition, Scenario, ScenarioMessage } from "./types.js";

export type SummaryScore = {
  recall: number | null;
  criticalRecall: number | null;
  recallByPosition: Record<FactPosition, number | null>;
  missedFacts: string[];
  leaks: number;
  summaryChars: number;
};

export type ProbeScore = {
  passed: number;
  total: number;
  rate: number | null;
  failed: string[];
  costUsd: number;
};

export type RunScore = SummaryScore & {
  probePass: number | null;
  probeFailed: string[];
  summaryCostUsd: number;
  probeCostUsd: number;
  totalCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
};

export type Stat = { mean: number; min: number; max: number; n: number };

const ratio = (hit: number, total: number): number | null => (total === 0 ? null : hit / total);

export function scoreSummary(scenario: Scenario, summary: string): SummaryScore {
  const hit = scenario.facts.filter((fact) => matchesText(fact.mustContain, summary));
  const critical = scenario.facts.filter((fact) => fact.critical);
  const position = (where: FactPosition): number | null => {
    const group = scenario.facts.filter((fact) => fact.where === where);
    return ratio(group.filter((fact) => matchesText(fact.mustContain, summary)).length, group.length);
  };
  const hitIds = new Set(hit.map((fact) => fact.id));
  return {
    recall: ratio(hit.length, scenario.facts.length),
    criticalRecall: ratio(critical.filter((fact) => hitIds.has(fact.id)).length, critical.length),
    recallByPosition: { early: position("early"), mid: position("mid"), late: position("late") },
    missedFacts: scenario.facts.filter((fact) => !hitIds.has(fact.id)).map((fact) => fact.id),
    leaks: scenario.secrets.filter((secret) => summary.includes(secret)).length,
    summaryChars: summary.length,
  };
}

export function renderTail(messages: readonly ScenarioMessage[]): string {
  return messages
    .map((message) => {
      const label = message.role === "toolResult" ? `tool result (${String(message.toolName ?? "tool")})` : message.role;
      return `[${label}]\n${messageText(message)}`;
    })
    .join("\n\n");
}

const PROBE_SYSTEM =
  "You are an agent resuming a long task after your earlier context was compacted. Use ONLY the summary and the recent messages given. " +
  "Answer in one or two sentences with exact values copied from the context. If the context does not contain the answer, say you do not know.";

export async function runProbes(scenario: Scenario, summary: string, model: EvalModel, signal?: AbortSignal): Promise<ProbeScore> {
  const tail = scenario.messages.slice(scenario.messages.length - scenario.keepTail);
  const context = `<summary>\n${summary}\n</summary>\n\n<recent-messages>\n${renderTail(tail)}\n</recent-messages>`;
  let passed = 0;
  let costUsd = 0;
  const failed: string[] = [];
  for (const probe of scenario.probes) {
    const reply = await model.complete({ system: PROBE_SYSTEM, user: `${context}\n\nQuestion: ${probe.question}`, ...(signal ? { signal } : {}) });
    costUsd += reply.costUsd;
    if (matchesText(probe.expected, reply.text)) passed++;
    else failed.push(probe.question);
  }
  return { passed, total: scenario.probes.length, rate: ratio(passed, scenario.probes.length), failed, costUsd };
}

export function stat(values: ReadonlyArray<number | null | undefined>): Stat | null {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return null;
  return { mean: nums.reduce((a, b) => a + b, 0) / nums.length, min: Math.min(...nums), max: Math.max(...nums), n: nums.length };
}

export type Aggregate = {
  runs: number;
  recall: Stat | null;
  criticalRecall: Stat | null;
  early: Stat | null;
  mid: Stat | null;
  late: Stat | null;
  probePass: Stat | null;
  leaks: Stat | null;
  summaryChars: Stat | null;
  totalCostUsd: Stat | null;
  latencyMs: Stat | null;
};

export function aggregate(runs: readonly RunScore[]): Aggregate {
  return {
    runs: runs.length,
    recall: stat(runs.map((r) => r.recall)),
    criticalRecall: stat(runs.map((r) => r.criticalRecall)),
    early: stat(runs.map((r) => r.recallByPosition.early)),
    mid: stat(runs.map((r) => r.recallByPosition.mid)),
    late: stat(runs.map((r) => r.recallByPosition.late)),
    probePass: stat(runs.map((r) => r.probePass)),
    leaks: stat(runs.map((r) => r.leaks)),
    summaryChars: stat(runs.map((r) => r.summaryChars)),
    totalCostUsd: stat(runs.map((r) => r.totalCostUsd)),
    latencyMs: stat(runs.map((r) => r.latencyMs)),
  };
}
