import type { EvalGraderStat, EvalResultDetail, EvalRunDetail } from "../../../api/evalTypes";
import { formatCost, formatPoints, formatScore, formatTokens } from "../format";
import { thresholdOf, type Tone } from "./headerModel";

export type GraderKindLabel = "Check" | "Rubric";

export function kindLabel(type: string): GraderKindLabel {
  return type === "rubric" ? "Rubric" : "Check";
}

type Definition = Record<string, any>;

export function graderDefinitions(run: Pick<EvalRunDetail, "config">): Definition[] {
  const list = run.config?.eval?.definition?.graders;
  return Array.isArray(list) ? (list as Definition[]) : [];
}

export function graderDefinition(run: Pick<EvalRunDetail, "config">, id: string): Definition | null {
  return graderDefinitions(run).find((g) => g.id === id) ?? null;
}

export function isOneToFive(def: Definition | null): boolean {
  return def?.type === "rubric" && def.scale === "1_to_5";
}

export function barTone(rate: number | null, threshold: number): Tone {
  if (rate === null) return "muted";
  if (rate >= threshold) return "ok";
  if (rate >= 0.5) return "needs";
  return "fail";
}

function rangeNumber(value: number, scaled: boolean): string {
  return scaled ? String(Math.round(value)) : value.toFixed(1);
}

export function deltaView(stat: Pick<EvalGraderStat, "delta" | "grader_changed">): { text: string; tone: Tone } {
  if (stat.delta === null) return { text: stat.grader_changed ? "grader changed" : "—", tone: "muted" };
  const rounded = Math.round(Math.abs(stat.delta) * 10) / 10;
  if (rounded === 0) return { text: "±0.0 pts", tone: "muted" };
  return { text: formatPoints(stat.delta), tone: stat.delta > 0 ? "ok" : "fail" };
}

export type GraderStatView = {
  id: string;
  kind: GraderKindLabel;
  passText: string;
  barFraction: number;
  barTone: Tone;
  meanText: string;
  rangeText: string;
  errorsText: string;
  errors: number;
  delta: { text: string; tone: Tone };
};

export function graderStatView(stat: EvalGraderStat, def: Definition | null, threshold: number): GraderStatView {
  const scaled = isOneToFive(def);
  const hasRange = stat.min_raw !== null && stat.max_raw !== null;
  return {
    id: stat.grader_id,
    kind: kindLabel(stat.type),
    passText: stat.pass_rate === null ? "—" : `${Math.round(stat.pass_rate * 100)}%`,
    barFraction: stat.pass_rate === null ? 0 : Math.max(0, Math.min(1, stat.pass_rate)),
    barTone: barTone(stat.pass_rate, threshold),
    meanText:
      stat.mean_raw === null ? "—" : scaled ? `${stat.mean_raw.toFixed(1)}/5` : formatScore(stat.mean_raw),
    rangeText: hasRange ? `${rangeNumber(stat.min_raw!, scaled)}-${rangeNumber(stat.max_raw!, scaled)}` : "—",
    errorsText: stat.errors === 0 ? "0" : String(stat.errors),
    errors: stat.errors,
    delta: deltaView(stat),
  };
}

export function byGraderRows(run: EvalRunDetail): GraderStatView[] {
  const threshold = thresholdOf(run);
  return (run.stats?.by_grader ?? []).map((stat) => graderStatView(stat, graderDefinition(run, stat.grader_id), threshold));
}

export function definitionSummary(def: Definition | null): string[] {
  if (!def) return [];
  switch (def.type) {
    case "rubric": {
      const lines = [String(def.rubric ?? "").trim()].filter((l) => l !== "");
      lines.push(def.scale === "1_to_5" ? `Scale 1 to 5 · passes at ${def.pass_at ?? 4}` : "Scale pass / fail");
      if (typeof def.judge === "string" && def.judge !== "") lines.push(`Judge ${def.judge}`);
      return lines;
    }
    case "field": {
      const checks = Array.isArray(def.checks) ? def.checks : [];
      return checks.map((c: Definition) =>
        c.value === undefined ? `${c.path} ${c.op}` : `${c.path} ${c.op} ${JSON.stringify(c.value)}`,
      );
    }
    case "reference":
      return [
        `${def.mode ?? "each_mentioned"}: ${def.path ?? "?"} against ${def.expected ?? "?"}`,
        `Passes at ${def.pass_at ?? 1}`,
      ];
    case "schema":
      return ["Output matches the stage's output schema"];
    case "code":
      return String(def.code ?? "")
        .split("\n")
        .slice(0, 12);
    default:
      return [];
  }
}

export type GraderRowView = GraderStatView & {
  type: string;
  description: string | null;
  weightText: string;
  hash: string;
  versionText: string | null;
  summary: string[];
  isRubric: boolean;
};

export function graderRows(run: EvalRunDetail): GraderRowView[] {
  const threshold = thresholdOf(run);
  const snapshot: Array<Record<string, any>> = Array.isArray(run.config?.graders) ? run.config.graders : [];
  const stats = new Map((run.stats?.by_grader ?? []).map((s) => [s.grader_id, s]));
  return snapshot.map((g) => {
    const def = graderDefinition(run, g.id);
    const stat: EvalGraderStat =
      stats.get(g.id) ??
      ({
        grader_id: g.id,
        type: g.type,
        hash: g.hash,
        graded: 0,
        passed: 0,
        pass_rate: null,
        mean_raw: null,
        min_raw: null,
        max_raw: null,
        errors: 0,
        delta: null,
        grader_changed: false,
      } satisfies EvalGraderStat);
    return {
      ...graderStatView(stat, def, threshold),
      type: g.type,
      description: typeof def?.description === "string" ? def.description : null,
      weightText: g.must_pass ? "must pass" : `×${g.weight ?? 1}`,
      hash: String(g.hash ?? "").slice(0, 6),
      versionText: g.type === "rubric" && g.version_ordinal ? `v${g.version_ordinal}` : null,
      summary: definitionSummary(def),
      isRubric: g.type === "rubric",
    };
  });
}

export type LowestCase = { caseId: string; repeatIndex: number; scoreText: string; reason: string | null };

export function lowestCases(results: EvalResultDetail[], graderId: string, limit = 5): LowestCase[] {
  const byCase = new Map<string, Array<{ repeat: number; score: number; reason: string | null }>>();
  for (const result of results) {
    const grade = result.grades.find((g) => g.grader_id === graderId);
    if (!grade || grade.status !== "graded" || grade.score === null) continue;
    const list = byCase.get(result.case_id) ?? [];
    list.push({ repeat: result.repeat_index, score: grade.score, reason: grade.reason });
    byCase.set(result.case_id, list);
  }
  const rows = [...byCase.entries()].map(([caseId, list]) => {
    const worst = [...list].sort((a, b) => a.score - b.score || a.repeat - b.repeat)[0]!;
    const mean = list.reduce((sum, item) => sum + item.score, 0) / list.length;
    return { caseId, mean, worst };
  });
  rows.sort((a, b) => a.mean - b.mean || (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  return rows.slice(0, limit).map(({ caseId, mean, worst }) => ({
    caseId,
    repeatIndex: worst.repeat,
    scoreText: formatScore(mean),
    reason: worst.reason,
  }));
}

export type JudgeSummary = { model: string; tokensText: string; costText: string } | null;

export function judgeSummary(results: EvalResultDetail[], graderId: string): JudgeSummary {
  let model: string | null = null;
  let tokens = 0;
  let cost = 0;
  let any = false;
  for (const result of results) {
    const grade = result.grades.find((g) => g.grader_id === graderId);
    if (!grade) continue;
    if (grade.judge_model) model = model ?? grade.judge_model;
    tokens += (grade.judge_tokens_in ?? 0) + (grade.judge_tokens_out ?? 0);
    cost += grade.judge_cost_usd ?? 0;
    any = true;
  }
  if (!any || model === null) return null;
  return { model, tokensText: `${formatTokens(tokens)} tokens`, costText: formatCost(cost) };
}
