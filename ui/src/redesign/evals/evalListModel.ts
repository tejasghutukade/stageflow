import type {
  EvalEngineStatus,
  EvalListItem,
  EvalListResponse,
  EvalListStatus,
  EvalRegressionBanner,
} from "../../api";
import { evalComparePath, evalEditPath, evalPath } from "../../routes";
import { formatCost, formatPercent, formatPoints } from "./format";

export const EVAL_SAMPLE_ID = "critique-sample";
export const TREND_SLOTS = 7;
export const EVALS_SUBTITLE =
  "Check a stage before you ship it. Each eval runs a stage against a dataset and grades every result.";
export const EMPTY_TITLE = "Know if a stage got better or worse";
export const EMPTY_BODY =
  "Run a stage on a set of example inputs, grade what comes back, and compare runs after every prompt or model change.";
export const EMPTY_FOOTER = "Evals live in evals/ and datasets in datasets/, beside your pipelines.";
export const EMPTY_STEPS: Array<{ title: string; body: string }> = [
  { title: "1. Pick a stage", body: "Start from any stage in the Catalog, or open Evaluate on a stage's page." },
  { title: "2. Add data", body: "Upload JSONL, JSON or CSV, type cases in a table, or reuse inputs from past runs." },
  {
    title: "3. Decide what good looks like",
    body: "Exact checks for structure, rubrics for quality, and limits for cost and speed.",
  },
];

export type EvalFilterTab = "all" | "stages" | "agents" | "regressed";

export type EvalTabDef = { id: EvalFilterTab; label: string; count?: number; soon?: boolean };

export type EvalTone = "ok" | "needs" | "fail" | "muted";

export function evalTabs(items: EvalListItem[]): EvalTabDef[] {
  return [
    { id: "all", label: "All", count: items.length },
    { id: "stages", label: "Stages", count: items.filter((i) => i.target.kind === "stage").length },
    { id: "agents", label: "Agents", soon: true },
    { id: "regressed", label: "Regressed", count: items.filter((i) => i.status === "regressed").length },
  ];
}

export function datasetName(datasetPath: string): string {
  const file = datasetPath.split("/").pop() ?? datasetPath;
  return file.replace(/\.dataset\.(jsonl|json|csv)$/, "").replace(/\.(jsonl|json|csv)$/, "");
}

function matchesQuery(item: EvalListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [
    item.id,
    item.name,
    item.target.stage_id ?? "",
    item.target.label,
    datasetName(item.dataset_path),
    item.dataset_path,
  ];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

export function filterEvals(
  items: EvalListItem[],
  opts: { tab: EvalFilterTab; query: string; stage?: string },
): EvalListItem[] {
  return items.filter((item) => {
    if (opts.tab === "regressed" && item.status !== "regressed") return false;
    if (opts.tab === "stages" && item.target.kind !== "stage") return false;
    if (opts.tab === "agents") return false;
    if (opts.stage && item.target.stage_id !== opts.stage) return false;
    return matchesQuery(item, opts.query);
  });
}

export const STATUS_LABEL: Record<EvalListStatus | "invalid", string> = {
  passing: "Passing",
  saturated: "Saturated",
  regressed: "Regressed",
  failing: "Failing",
  never_run: "Never run",
  invalid: "Needs fixing",
};

const STATUS_TONE: Record<EvalListStatus | "invalid", EvalTone> = {
  passing: "ok",
  saturated: "needs",
  regressed: "fail",
  failing: "fail",
  never_run: "muted",
  invalid: "needs",
};

export function statusOf(item: EvalListItem): { label: string; tone: EvalTone } {
  const key = item.valid ? item.status : "invalid";
  return { label: STATUS_LABEL[key], tone: STATUS_TONE[key] };
}

export type TrendDot = { tone: EvalTone | "empty"; title: string };

export function trendDots(item: EvalListItem): TrendDot[] {
  const dots: TrendDot[] = item.trend.slice(-TREND_SLOTS).map((point) => {
    const near = point.pass_rate !== null && point.pass_rate >= point.pass_threshold - 0.05;
    const tone: TrendDot["tone"] = point.passed ? "ok" : near ? "needs" : "fail";
    return { tone, title: `Run #${point.run_number} · ${formatPercent(point.pass_rate)}` };
  });
  while (dots.length < TREND_SLOTS) dots.push({ tone: "empty", title: "" });
  return dots;
}

export type EvalRowModel = {
  id: string;
  name: string;
  description: string | null;
  targetLabel: string;
  targetPath: string;
  datasetName: string;
  datasetMeta: string;
  hasRun: boolean;
  rateText: string;
  rateTone: EvalTone;
  deltaText: string | null;
  deltaTone: EvalTone;
  barPercent: number;
  trend: TrendDot[];
  costText: string;
  status: { label: string; tone: EvalTone };
  href: string;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function targetPath(item: EvalListItem): string {
  return item.target.file ?? item.target.pipeline_path ?? "";
}

function datasetMeta(item: EvalListItem): string {
  const type = item.type.charAt(0).toUpperCase() + item.type.slice(1);
  if (item.id === EVAL_SAMPLE_ID) {
    return `${type} · ${plural(item.dataset_cases, "case", "cases")} · sample data`;
  }
  return `${type} · ${plural(item.dataset_cases, "case", "cases")} · ${plural(item.repeats, "repeat", "repeats")}`;
}

export function evalRowModel(item: EvalListItem): EvalRowModel {
  const last = item.last_run;
  const rate = last?.pass_rate ?? null;
  const delta = item.last_run_delta_pts;
  return {
    id: item.id,
    name: item.name || item.id,
    description: item.description,
    targetLabel: item.target.label,
    targetPath: targetPath(item),
    datasetName: datasetName(item.dataset_path),
    datasetMeta: datasetMeta(item),
    hasRun: last !== null,
    rateText: formatPercent(rate),
    rateTone: last === null ? "muted" : last.passed ? "ok" : "fail",
    deltaText: delta === null ? null : formatPoints(delta),
    deltaTone: delta === null || Math.round(Math.abs(delta) * 10) === 0 ? "muted" : delta > 0 ? "ok" : "fail",
    barPercent: rate === null ? 0 : Math.max(0, Math.min(100, Math.round(rate * 100))),
    trend: trendDots(item),
    costText: last === null ? "—" : formatCost(last.cost_total),
    status: statusOf(item),
    href: item.valid ? evalPath(item.id) : evalEditPath(item.id),
  };
}

export type BannerModel = { title: string; detail: string; compareHref: string };

export function bannerModel(banner: EvalRegressionBanner | null): BannerModel | null {
  if (banner === null) return null;
  return {
    title: `${banner.eval_id} regressed`,
    detail: `Pass rate ${formatPercent(banner.previous_pass_rate)} → ${formatPercent(banner.last_pass_rate)} · ${plural(
      banner.criteria_dropped,
      "criterion",
      "criteria",
    )} dropped · run #${banner.last_run_number} vs #${banner.previous_run_number}`,
    compareHref: evalComparePath(banner.eval_id, { a: banner.previous_run_number, b: banner.last_run_number }),
  };
}

export function saturatedGuidance(items: EvalListItem[]): string | null {
  const saturated = items.find((item) => item.valid && item.status === "saturated");
  if (!saturated) return null;
  return `${saturated.id} passes every case, so it can no longer show improvement. Move it to a regression eval to keep guarding it, and add harder cases to a new capability eval.`;
}

export function footerText(footer: EvalListResponse["footer"]): string {
  return `${plural(footer.evals, "eval", "evals")} in evals/ · ${plural(
    footer.datasets,
    "dataset",
    "datasets",
  )} in datasets/ · ${formatCost(footer.cost_last_7_days)} in the last 7 days`;
}

export type EngineBannerModel = { reason: string; command: string };

export function engineBanner(status: EvalEngineStatus | null): EngineBannerModel | null {
  if (status === null) return null;
  if (!status.node_ok) {
    return {
      reason: `The eval engine needs a newer Node than ${status.node}. Evals cannot run until Node is upgraded.`,
      command: status.install_command,
    };
  }
  if (!status.installed) {
    return {
      reason: "The eval engine is not installed. Evals cannot run until it is.",
      command: status.install_command,
    };
  }
  return null;
}

export function moveSelection(ids: string[], current: string | null, direction: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index < 0) return direction === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.max(0, Math.min(ids.length - 1, index + direction))]!;
}
