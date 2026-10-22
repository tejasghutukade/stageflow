import type {
  EvalCompareCase,
  EvalCompareResult,
  EvalNumberDelta,
  EvalRunDetail,
  EvalRunListItem,
} from "../../../api/evalTypes";
import { formatCost, formatDuration, formatMean, formatPercent, formatScore } from "../format";
import { agentIdOf } from "../agentRun";

const MINUS = "−";

export type Tone = "ok" | "needs" | "fail" | "muted";

export const STAGE_DIFF_COLLAPSED_LINES = 12;
export const BAR_FULL_POINTS = 10;
export const EMPTY_STATE_TEXT = "Run the eval at least twice to compare";

export type PickerOption = { runNumber: number; label: string };

export function pickerLabel(runNumber: number, passRate: number | null): string {
  return passRate === null ? `Run #${runNumber}` : `Run #${runNumber} · ${formatPercent(passRate)}`;
}

export function pickerOptions(
  runs: Array<Pick<EvalRunListItem, "run_number" | "pass_rate">>,
  extra: Array<{ run_number: number; pass_rate: number | null }> = [],
): PickerOption[] {
  const byNumber = new Map<number, number | null>();
  for (const run of [...extra, ...runs]) byNumber.set(run.run_number, run.pass_rate);
  return [...byNumber.entries()]
    .sort((x, y) => y[0] - x[0])
    .map(([runNumber, rate]) => ({ runNumber, label: pickerLabel(runNumber, rate) }));
}

export type Selection = { a: number; b: number };

/** Query wins when both numbers are given; otherwise b = latest completed run, a = the one before it. */
export function defaultSelection(
  completedRunNumbers: number[],
  query: { a?: number; b?: number },
): Selection | null {
  if (query.a !== undefined && query.b !== undefined) return { a: query.a, b: query.b };
  const sorted = [...completedRunNumbers].sort((x, y) => y - x);
  const b = query.b ?? sorted.find((n) => n !== query.a);
  if (b === undefined) return null;
  const a = query.a ?? sorted.find((n) => n < b);
  if (a === undefined) return null;
  return { a, b };
}

function signed(value: number, text: string): string {
  if (value > 0) return `+${text}`;
  if (value < 0) return `${MINUS}${text}`;
  return text;
}

export function formatSignedPoints(points: number | null | undefined, digits = 1): string {
  if (points === null || points === undefined || !Number.isFinite(points)) return "—";
  const abs = Math.abs(points).toFixed(digits);
  return `${signed(Number(abs) === 0 ? 0 : points, abs)} pts`;
}

function signedInt(value: number): string {
  const rounded = Math.round(value);
  return signed(rounded, String(Math.abs(rounded)));
}

export function ciText(ci: EvalCompareResult["ci"]): string | null {
  if (!ci) return null;
  const low = Math.round(ci.low * 100);
  const high = Math.round(ci.high * 100);
  return `95% CI ${signed(low, String(Math.abs(low)))} to ${signed(high, String(Math.abs(high)))}`;
}

export type VerdictModel = { word: string; tone: Tone };

export function verdictModel(verdict: EvalCompareResult["verdict"]): VerdictModel {
  switch (verdict) {
    case "improved":
      return { word: "improved", tone: "ok" };
    case "regressed":
      return { word: "regressed", tone: "fail" };
    case "no_clear_difference":
      return { word: "inconclusive", tone: "muted" };
    case "insufficient_data":
      return { word: "not enough shared cases", tone: "muted" };
  }
}

export type KpiTile = {
  key: string;
  label: string;
  value: string;
  sub: string;
  subTone: Tone;
};

function pairText(a: string, b: string): string {
  return `${a} → ${b}`;
}

function percentChange(delta: EvalNumberDelta): string | null {
  if (delta.a === null || delta.b === null || delta.a === 0) return null;
  const pct = Math.round(((delta.b - delta.a) / delta.a) * 100);
  return `${signed(pct, String(Math.abs(pct)))}%`;
}

function signToneUp(delta: number | null): Tone {
  if (delta === null || delta === 0) return "muted";
  return delta > 0 ? "ok" : "fail";
}

export function buildKpiTiles(result: EvalCompareResult): KpiTile[] {
  const { stats_a: sa, stats_b: sb, deltas } = result;
  const verdict = verdictModel(result.verdict);

  const rateDelta = result.mean_difference === null ? null : result.mean_difference * 100;
  const rateSub = [
    rateDelta === null ? null : formatSignedPoints(rateDelta),
    ciText(result.ci),
    verdict.word,
  ].filter((part): part is string => part !== null);

  const scoreDelta = deltas.mean_score.delta;
  const flaky = deltas.flaky_cases;
  const flakyDelta = flaky.delta;
  const flakySub =
    flakyDelta === null
      ? "—"
      : flakyDelta === 0
        ? "no change"
        : `${signedInt(flakyDelta)} · ${flakyDelta < 0 ? "steadier" : "flakier"}`;

  const latency = deltas.latency_p50;
  const latencySub =
    latency.delta === null
      ? "—"
      : latency.delta === 0
        ? "no change"
        : `${signed(latency.delta, (Math.abs(latency.delta) / 1000).toFixed(1))} s`;

  const cost = deltas.cost_per_result;
  const costChange = percentChange(cost);
  const costTone: Tone = cost.delta === null || cost.delta === 0 ? "muted" : cost.delta > 0 ? "needs" : "ok";

  const tiles: KpiTile[] = [
    {
      key: "pass_rate",
      label: "Pass rate",
      value: pairText(formatPercent(sa.pass_rate), formatPercent(sb.pass_rate)),
      sub: rateSub.join(" · "),
      subTone: verdict.tone,
    },
    {
      key: "mean_score",
      label: "Mean score",
      value: pairText(formatScore(deltas.mean_score.a), formatScore(deltas.mean_score.b)),
      sub: scoreDelta === null ? "—" : signed(scoreDelta, Math.abs(scoreDelta).toFixed(2)),
      subTone: signToneUp(scoreDelta === null ? null : Number(scoreDelta.toFixed(2))),
    },
    {
      key: "flaky",
      label: "Flaky cases",
      value: pairText(flaky.a === null ? "—" : String(flaky.a), flaky.b === null ? "—" : String(flaky.b)),
      sub: flakySub,
      subTone: flakyDelta === null || flakyDelta === 0 ? "muted" : flakyDelta < 0 ? "ok" : "fail",
    },
    {
      key: "latency_p50",
      label: "Latency p50",
      value: pairText(formatDuration(latency.a), formatDuration(latency.b)),
      sub: latencySub,
      subTone: "muted",
    },
    {
      key: "cost",
      label: "Cost per run",
      value: pairText(formatCost(cost.a), formatCost(cost.b)),
      sub: costChange ?? "—",
      subTone: costTone,
    },
  ];
  for (const [key, label, delta] of [
    ["mean_turns", "Turns", deltas.mean_turns],
    ["mean_tool_calls", "Tool calls", deltas.mean_tool_calls],
  ] as const) {
    if (!delta) continue;
    tiles.push({
      key,
      label,
      value: pairText(formatMean(delta.a), formatMean(delta.b)),
      sub: delta.delta === null ? "—" : delta.delta === 0 ? "no change" : `${signed(delta.delta, formatMean(Math.abs(delta.delta)))} per conversation`,
      subTone: "muted",
    });
  }
  return tiles;
}

/** Both runs are agent runs. */
export function isAgentCompare(result: EvalCompareResult): boolean {
  return result.deltas.mean_turns !== undefined || result.deltas.mean_tool_calls !== undefined || (result.agent_diff ?? null) !== null;
}

const AGENT_CONVERSATION_LABELS: Array<[string, string]> = [
  ["tools", "tool policy"],
  ["approvals", "approvals"],
  ["mode", "mode"],
  ["max_turns", "max turns"],
  ["user_model", "user model"],
  ["turn_timeout_ms", "turn timeout"],
  ["read_only_tools", "read-only tools"],
  ["simulator_prompt_version", "simulator prompt"],
];

function agentObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function plain(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  return String(value);
}

/** Tool policy, approvals, mode, max turns and user model first: those are the conversation settings a result depends on. */
export function agentSettingChanges(a: unknown, b: unknown): string[] {
  const oa = agentObject(a);
  const ob = agentObject(b);
  return AGENT_CONVERSATION_LABELS.filter(([key]) => JSON.stringify(oa[key]) !== JSON.stringify(ob[key])).map(
    ([key, label]) => `${label} ${plain(oa[key])} to ${plain(ob[key])}`,
  );
}

function agentKept(value: unknown): string {
  const o = agentObject(value);
  const parts = [
    o.tools !== undefined ? `tool policy ${plain(o.tools)}` : null,
    o.approvals !== undefined ? `approvals ${plain(o.approvals)}` : null,
    o.mode !== undefined ? `mode ${plain(o.mode)}` : null,
    o.max_turns !== undefined ? `${plain(o.max_turns)} turns` : null,
    o.user_model ? `user model ${plain(o.user_model)}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "conversation settings";
}

const COMPONENT_LABELS: Record<string, string> = {
  stage: "stage version",
  agent: "conversation",
  model: "model",
  dataset: "dataset",
  case_ids: "case selection",
  graders: "graders",
  judge: "judge",
  repeats: "repeats",
  pass_threshold: "threshold",
  engine: "engine",
  rubric_prompt_version: "rubric prompt",
};

function short(hash: string): string {
  return /^[0-9a-f]{8,}$/i.test(hash) ? hash.slice(0, 6) : hash;
}

function scalarText(key: string, value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return key === "dataset" || key === "stage" ? short(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "case" : "cases"}`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.name === "string") return typeof rec.version === "string" ? `${rec.name} ${rec.version}` : rec.name;
    if (key === "graders") return `${Object.keys(rec).length}`;
  }
  return JSON.stringify(value);
}

function keptText(key: string, value: unknown): string {
  const label = COMPONENT_LABELS[key] ?? key;
  const text = scalarText(key, value);
  if (key === "graders") return `${text} graders`;
  if (key === "repeats") return `${text} ${Number(value) === 1 ? "repeat" : "repeats"}`;
  if (key === "pass_threshold") return `threshold ${formatPercent(typeof value === "number" ? value : null)}`;
  if (key === "case_ids") return value === null ? "all cases" : `${text}`;
  return `${label} ${text}`;
}

function changedGraderIds(a: unknown, b: unknown): string[] {
  const ra = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const rb = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((id) => ra[id] !== rb[id]).sort();
}

function changedText(key: string, a: unknown, b: unknown): string {
  const label = COMPONENT_LABELS[key] ?? key;
  if (key === "graders") {
    const ids = changedGraderIds(a, b);
    return ids.length > 0 ? `graders ${ids.join(", ")}` : "graders";
  }
  if (key === "case_ids") return "case selection";
  if (key === "pass_threshold") {
    return `threshold ${formatPercent(typeof a === "number" ? a : null)} to ${formatPercent(typeof b === "number" ? b : null)}`;
  }
  return `${label} ${scalarText(key, a)} to ${scalarText(key, b)}`;
}

export type StripModel = {
  held: string[];
  changed: string[];
  warnings: string[];
  amber: boolean;
};

export function warningText(warning: EvalCompareResult["warnings"][number]): string {
  switch (warning.code) {
    case "dataset_differs":
      return `Datasets differ. Only the ${warning.shared_cases ?? 0} shared cases are compared (${warning.shared_cases ?? 0} of ${warning.cases_a ?? 0} / ${warning.cases_b ?? 0}).`;
    case "graders_differ":
      return "Graders differ; scores are not comparable.";
    case "engine_differs":
      return "The eval engine differs between the runs.";
    case "few_shared_cases":
      return `Only ${warning.shared_cases ?? 0} shared cases; at least 5 are needed for a verdict.`;
  }
}

export function buildStrip(result: EvalCompareResult): StripModel {
  const held: string[] = [];
  const changed: string[] = [];
  const agent = isAgentCompare(result);
  for (const component of result.components) {
    if (agent && component.key === "agent") {
      if (component.status === "same") held.push(agentKept(component.a));
      else changed.push(...agentSettingChanges(component.a, component.b).filter((text) => !text.startsWith("revision")));
      continue;
    }
    if (agent && component.key === "stage") {
      if (component.status === "same") held.push(`agent definition ${scalarText("stage", component.a)}`);
      else changed.push(`agent definition ${scalarText("stage", component.a)} to ${scalarText("stage", component.b)}`);
      continue;
    }
    if (component.status === "same") held.push(keptText(component.key, component.a));
    else changed.push(changedText(component.key, component.a, component.b));
  }
  const differs = (key: string) => result.components.some((c) => c.key === key && c.status === "changed");
  const warnings = result.warnings.map(warningText);
  const settingsDiffer = agent && result.components.some((c) => c.key === "agent" && c.status === "changed" && agentSettingChanges(c.a, c.b).length > 0);
  const amber = differs("dataset") || differs("graders") || differs("engine") || settingsDiffer;
  return { held, changed, warnings, amber };
}

/** Footer chips: what stayed the same, or what differs. */
export function configChip(result: EvalCompareResult): { text: string; amber: boolean } {
  const differing = ["dataset", "graders", "judge"].filter((key) =>
    result.components.some((c) => c.key === key && c.status === "changed"),
  );
  if (differing.length === 0) return { text: "Same dataset · same graders · same judge", amber: false };
  return { text: `Different ${differing.join(" · ")}`, amber: true };
}

export type GraderRow = {
  id: string;
  aText: string;
  bText: string;
  deltaText: string;
  tone: Tone;
  /** Bar from the center line: side and width as a percent of the full track. */
  bar: { side: "left" | "right"; widthPercent: number } | null;
};

export function barGeometry(deltaPoints: number | null): GraderRow["bar"] {
  if (deltaPoints === null || !Number.isFinite(deltaPoints)) return null;
  const rounded = Math.round(deltaPoints * 10) / 10;
  if (rounded === 0) return null;
  const widthPercent = Math.min(Math.abs(deltaPoints) / BAR_FULL_POINTS, 1) * 50;
  return { side: deltaPoints > 0 ? "right" : "left", widthPercent };
}

export function buildGraderRows(result: EvalCompareResult): GraderRow[] {
  return result.graders.map((g) => {
    if (g.status === "changed") {
      return { id: g.grader_id, aText: "—", bText: "—", deltaText: "changed", tone: "needs", bar: null };
    }
    if (g.status === "added" || g.status === "removed") {
      return {
        id: g.grader_id,
        aText: formatPercent(g.pass_rate_a),
        bText: formatPercent(g.pass_rate_b),
        deltaText: g.status,
        tone: "muted",
        bar: null,
      };
    }
    const bar = barGeometry(g.delta);
    const rounded = g.delta === null ? null : Math.round(g.delta * 10) / 10;
    return {
      id: g.grader_id,
      aText: formatPercent(g.pass_rate_a),
      bText: formatPercent(g.pass_rate_b),
      deltaText: g.delta === null ? "—" : rounded === 0 ? "no change" : formatSignedPoints(g.delta),
      tone: rounded === null || rounded === 0 ? "muted" : rounded > 0 ? "ok" : "fail",
      bar,
    };
  });
}

export type CaseTab = "fixed" | "regressed" | "unchanged";

export const CASE_TABS: Array<{ key: CaseTab; label: string; change: EvalCompareCase["change"] }> = [
  { key: "fixed", label: "Fixed", change: "improved" },
  { key: "regressed", label: "Regressed", change: "regressed" },
  { key: "unchanged", label: "Unchanged", change: "same" },
];

export type CaseInfo = { id: string; title: string | null; position: number };

export type CaseRowModel = {
  caseId: string;
  position: number | null;
  title: string;
  before: boolean[];
  after: boolean[];
  scoreText: string;
  scoreTone: Tone;
  gradersChanged: string[];
};

export function caseCounts(cases: EvalCompareCase[]): Record<CaseTab, number> {
  return {
    fixed: cases.filter((c) => c.change === "improved").length,
    regressed: cases.filter((c) => c.change === "regressed").length,
    unchanged: cases.filter((c) => c.change === "same").length,
  };
}

export function buildCaseRows(
  cases: EvalCompareCase[],
  tab: CaseTab,
  info: CaseInfo[] | null,
): CaseRowModel[] {
  const change = CASE_TABS.find((t) => t.key === tab)!.change;
  const byId = new Map((info ?? []).map((c) => [c.id, c]));
  return cases
    .filter((c) => c.change === change)
    .map((c) => {
      const known = byId.get(c.case_id);
      const diff =
        c.mean_score_a !== null && c.mean_score_b !== null ? c.mean_score_b - c.mean_score_a : null;
      const rounded = diff === null ? null : Math.round(diff * 100) / 100;
      return {
        caseId: c.case_id,
        position: known?.position ?? null,
        title: known?.title ?? c.case_id,
        before: c.passes_a,
        after: c.passes_b,
        scoreText:
          diff === null ? "—" : rounded === 0 ? "0.00" : signed(rounded as number, Math.abs(diff).toFixed(2)),
        scoreTone: rounded === null || rounded === 0 ? "muted" : rounded > 0 ? "ok" : "fail",
        gradersChanged: c.graders_changed,
      };
    });
}

export type StageDiffLine = { op: "same" | "add" | "remove"; text: string };

export type StageDiffModel = {
  title: string;
  hashes: string | null;
  lines: StageDiffLine[];
  canExpand: boolean;
  summary: string;
};

const WELL_KNOWN_UNCHANGED = ["model", "tools", "io.output"];

export function stageDiffSummary(changedKeys: string[]): string {
  if (changedKeys.length === 0) return "Stage version changed";
  const touched = (candidate: string) =>
    changedKeys.some((k) => k === candidate || k.startsWith(`${candidate}.`) || candidate.startsWith(`${k}.`));
  const unchanged = WELL_KNOWN_UNCHANGED.filter((k) => !touched(k));
  const text = changedKeys.map((k) => (k === "system_prompt" ? "System prompt edited" : `${k} changed`)).join(", ");
  return unchanged.length > 0 ? `${text} · ${listWithAnd(unchanged)} unchanged` : text;
}

function listWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function buildStageDiff(
  result: EvalCompareResult,
  stageId: string | null,
  expanded: boolean,
): StageDiffModel | null {
  const diff = result.stage_diff;
  if (!diff) return null;
  const stage = result.components.find((c) => c.key === "stage");
  const hashes =
    stage && typeof stage.a === "string" && typeof stage.b === "string"
      ? `${short(stage.a)} → ${short(stage.b)}`
      : null;
  const all = diff.system_prompt_diff ?? [];
  const changedOnly = all.filter((line) => line.op !== "same");
  const collapsed = changedOnly.slice(0, STAGE_DIFF_COLLAPSED_LINES);
  return {
    title: stageId ? `What changed in stage ${stageId}` : "What changed in the stage",
    hashes,
    lines: expanded ? all : collapsed,
    canExpand: all.length > collapsed.length,
    summary: stageDiffSummary(diff.changed_keys),
  };
}

export type AgentDiffModel = StageDiffModel;

export function agentDiffSummary(changedKeys: string[]): string {
  if (changedKeys.length === 0) return "Agent changed";
  const touched = (candidate: string) => changedKeys.some((k) => k === candidate || k.startsWith(`${candidate}.`));
  const unchanged = ["model", "tools", "limits"].filter((k) => !touched(k));
  const text = changedKeys.map((k) => (k === "instructions" ? "Instructions edited" : `${k} changed`)).join(", ");
  return unchanged.length > 0 ? `${text} · ${listWithAnd(unchanged)} unchanged` : text;
}

export function buildAgentDiff(result: EvalCompareResult, agentId: string | null, expanded: boolean): AgentDiffModel | null {
  const diff = result.agent_diff;
  if (!diff) return null;
  const revision = diff.revision.a !== null && diff.revision.b !== null ? `r${diff.revision.a} → r${diff.revision.b}` : null;
  const all = diff.instructions_diff ?? [];
  const collapsed = all.filter((line) => line.op !== "same").slice(0, STAGE_DIFF_COLLAPSED_LINES);
  return {
    title: agentId ? `What changed in agent ${agentId}` : "What changed in the agent",
    hashes: revision,
    lines: expanded ? all : collapsed,
    canExpand: all.length > collapsed.length,
    summary: agentDiffSummary(diff.changed_keys),
  };
}

export const COMPARE_SUBTITLE_STAGE = "See what changed in the stage and what that did to the results.";
export const COMPARE_SUBTITLE_AGENT = "See what changed in the agent and what that did to the results.";

export function agentIdOfRun(run: Pick<EvalRunDetail, "config"> | null): string | null {
  return run ? agentIdOf(run) : null;
}

export function footerNote(result: EvalCompareResult): string {
  const base =
    "Differences are paired by case. A change counts as real only when its 95% interval excludes zero.";
  if (result.cases_needed_5pts === null) return base;
  return `${base} With ${result.shared_cases} cases only large changes show up; about ${result.cases_needed_5pts} cases are needed to detect 5 points.`;
}

export function stageIdOf(run: Pick<EvalRunDetail, "config"> | null): string | null {
  const target = run?.config?.target ?? {};
  const id = target.stage_id ?? target.file ?? null;
  return typeof id === "string" && id !== "" ? id : null;
}

export function compareErrorText(code: string | null, message: string, which?: number): string {
  if (code === "EVAL_COMPARE_MISMATCH") return "These two runs belong to different evals and cannot be compared.";
  if (which !== undefined && /NOT_FOUND|HTTP_404/.test(code ?? "")) return `Run #${which} no longer exists.`;
  return message;
}
