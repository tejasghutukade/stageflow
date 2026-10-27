import type {
  EvalResultRow,
  EvalResultStatus,
  EvalRunDetail,
  EvalRunStatus,
} from "../../../api/evalTypes";
import { formatCost, formatDuration, formatPercent, formatScore } from "../format";
import { datasetName } from "../evalListModel";
import { agentRunLabel, internalAgentLabel, isAgentRun, targetModelOf } from "../agentRun";
import { formatLimit } from "./runDialogModel";

export const MIN_RESULTS_FOR_ESTIMATE = 3;
export const POLL_INTERVAL_MS = 1500;
export const STOP_CONFIRM_TEXT = "Stopping keeps the results so far.";
export const LEAVE_NOTE = "You can leave this page. The run keeps going and shows up under Evals.";

export function isActiveStatus(status: EvalRunStatus): boolean {
  return status === "queued" || status === "running";
}

export type DotState = "passed" | "failed" | "running" | "queued";

export type LiveCase = { id: string; title: string | null; position: number };

export type LiveEntry = NonNullable<EvalRunDetail["live"]>[number];

export type LiveRowModel = {
  caseId: string;
  position: number | null;
  label: string;
  dots: DotState[];
  scoreText: string;
  scoreTone: "ok" | "needs" | "fail" | "muted";
  nowText: string;
  nowTone: "running" | "muted" | "fail";
};

export type BarSegment = { kind: DotState; percent: number };

export type LiveModel = {
  total: number;
  counts: { passed: number; failed: number; running: number; queued: number };
  segments: BarSegment[];
  headline: string;
  percentText: string;
  passingText: string;
  costText: string;
  elapsedText: string;
  leftText: string;
  rows: LiveRowModel[];
  footer: string;
};

function dotForStatus(status: EvalResultStatus, passed: boolean): DotState | null {
  if (status === "completed") return passed ? "passed" : "failed";
  if (status === "stage_failed" || status === "needs_input" || status === "error") return "failed";
  return null;
}

export function elapsedMs(run: Pick<EvalRunDetail, "created_at" | "started_at" | "finished_at">, now: number): number | null {
  const start = run.started_at ?? null;
  if (start === null) return null;
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return null;
  const endMs = run.finished_at ? Date.parse(run.finished_at) : now;
  const end = Number.isFinite(endMs) ? endMs : now;
  return Math.max(0, end - startMs);
}

export function estimatedLeftMs(elapsed: number | null, resultsDone: number, resultsTotal: number): number | null {
  if (elapsed === null || resultsDone < MIN_RESULTS_FOR_ESTIMATE) return null;
  const remaining = resultsTotal - resultsDone;
  if (remaining <= 0) return null;
  return (elapsed / resultsDone) * remaining;
}

/** What a failed agent repeat shows in the Now column. The row only carries the stored status, so a timeout reads as "Agent failed". */
export function agentFailureLabel(statuses: readonly EvalResultStatus[]): string | null {
  if (statuses.includes("stage_failed")) return "Agent failed";
  if (statuses.includes("error")) return "Error";
  return null;
}

export function nowText(
  entry: LiveEntry | undefined,
  allDone: boolean,
  failure: string | null = null,
): { text: string; tone: "running" | "muted" | "fail" } {
  if (allDone) return failure ? { text: failure, tone: "fail" } : { text: "Done", tone: "muted" };
  if (entry && entry.phase === "agent_running") {
    return { text: `Agent is talking, repeat ${entry.repeat_index + 1}`, tone: "running" };
  }
  if (entry && entry.phase === "stage_running") {
    return { text: `Stage is running repeat ${entry.repeat_index + 1}`, tone: "running" };
  }
  if (entry && entry.phase === "grading") {
    return { text: `Judge is grading repeat ${entry.repeat_index + 1}`, tone: "running" };
  }
  return { text: "Queued", tone: "muted" };
}

function scoreTone(score: number | null, threshold: number | null): LiveRowModel["scoreTone"] {
  if (score === null) return "muted";
  const t = threshold ?? 0.8;
  if (score >= t) return "ok";
  if (score >= t - 0.05) return "needs";
  return "fail";
}

function repeatsTotal(run: EvalRunDetail, rows: EvalResultRow[]): number {
  const configured = Number(run.config?.settings?.repeats);
  const seen = rows.reduce((max, row) => Math.max(max, row.repeats.length), 0);
  const base = Number.isInteger(configured) && configured > 0 ? configured : 0;
  return Math.max(base, seen, 1);
}

export function buildRows(input: {
  run: EvalRunDetail;
  rows: EvalResultRow[];
  cases: LiveCase[] | null;
}): LiveRowModel[] {
  const { run, rows, cases } = input;
  const live = run.live ?? [];
  const total = repeatsTotal(run, rows);
  const threshold = Number(run.config?.settings?.pass_threshold);
  const thr = Number.isFinite(threshold) ? threshold : null;
  const byCase = new Map(rows.map((row) => [row.case_id, row]));
  const subset = Array.isArray((run.components as { case_ids?: unknown })?.case_ids)
    ? new Set((run.components as { case_ids: string[] }).case_ids)
    : null;
  const skipped = new Set<string>(
    Array.isArray(run.config?.dataset?.skipped_case_ids) ? run.config.dataset.skipped_case_ids : [],
  );

  type Source = { id: string; title: string | null; position: number | null; order: number };
  const sources = new Map<string, Source>();
  (cases ?? []).forEach((c, index) => {
    if (subset && !subset.has(c.id)) return;
    if (skipped.has(c.id)) return;
    sources.set(c.id, { id: c.id, title: c.title, position: c.position, order: index });
  });
  let extra = sources.size;
  const known = (id: string, title: string | null, position: number | null) => {
    if (!sources.has(id)) sources.set(id, { id, title, position, order: extra++ });
  };
  rows.forEach((row) => known(row.case_id, row.title, row.position ?? null));
  live.forEach((entry) => known(entry.case_id, null, null));

  const out: LiveRowModel[] = [];
  for (const source of [...sources.values()].sort((a, b) => a.order - b.order)) {
    const row = byCase.get(source.id);
    const entries = live
      .filter((e) => e.case_id === source.id && e.phase !== "done")
      .sort((a, b) => a.repeat_index - b.repeat_index);
    const dots: DotState[] = [];
    let finished = 0;
    for (let i = 0; i < total; i += 1) {
      const result = row?.repeats.find((r) => r.repeat_index === i);
      const state = result ? dotForStatus(result.status, result.passed) : null;
      if (state) {
        dots.push(state);
        finished += 1;
      } else if (live.some((e) => e.case_id === source.id && e.repeat_index === i)) {
        dots.push("running");
      } else {
        dots.push("queued");
      }
    }
    const mean = row?.mean_score ?? null;
    const failure = isAgentRun(run) ? agentFailureLabel((row?.repeats ?? []).map((r) => r.status)) : null;
    const now = nowText(entries[0], finished >= total, failure);
    out.push({
      caseId: source.id,
      position: source.position,
      label: row?.title ?? source.title ?? source.id,
      dots,
      scoreText: formatScore(mean),
      scoreTone: scoreTone(mean, thr),
      nowText: now.text,
      nowTone: now.tone,
    });
  }
  return out;
}

export function buildCounts(input: {
  total: number;
  rows: EvalResultRow[];
  live: LiveEntry[];
}): LiveModel["counts"] {
  const { total, rows, live } = input;
  let passed = 0;
  let failed = 0;
  const finishedKeys = new Set<string>();
  for (const row of rows) {
    for (const r of row.repeats) {
      const state = dotForStatus(r.status, r.passed);
      if (state === "passed") passed += 1;
      else if (state === "failed") failed += 1;
      if (state) finishedKeys.add(`${row.case_id}\0${r.repeat_index}`);
    }
  }
  passed = Math.min(passed, total);
  failed = Math.min(failed, total - passed);
  const inFlight = live.filter((e) => e.phase !== "done" && !finishedKeys.has(`${e.case_id}\0${e.repeat_index}`)).length;
  const running = Math.min(inFlight, total - passed - failed);
  return { passed, failed, running, queued: total - passed - failed - running };
}

export function buildSegments(counts: LiveModel["counts"], total: number): BarSegment[] {
  if (total <= 0) return [];
  const kinds: DotState[] = ["passed", "failed", "running", "queued"];
  return kinds.map((kind) => ({ kind, percent: (counts[kind] / total) * 100 }));
}

export function buildLiveModel(input: {
  run: EvalRunDetail;
  results: EvalResultRow[];
  cases: LiveCase[] | null;
  now: number;
}): LiveModel {
  const { run, results, cases, now } = input;
  const total = run.progress.results_total;
  const done = run.progress.results_done;
  const counts = buildCounts({ total, rows: results, live: run.live ?? [] });
  const graded = counts.passed + counts.failed;
  const elapsed = elapsedMs(run, now);
  const left = estimatedLeftMs(elapsed, done, total);
  const inProgress = counts.running;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    total,
    counts,
    segments: buildSegments(counts, total),
    headline: `${done} of ${total} results graded · ${inProgress} in progress`,
    percentText: `${percent}%`,
    passingText: graded > 0 ? formatPercent(counts.passed / graded) : "—",
    costText: `${formatCost(run.progress.cost_usd)} of ${formatLimit(run.progress.max_cost_usd)} limit`,
    elapsedText: elapsed === null ? "—" : formatDuration(elapsed),
    leftText: left === null ? "—" : `about ${formatDuration(left)}`,
    rows: buildRows({ run, rows: results, cases }),
    footer: `The run stops by itself if it reaches the ${formatLimit(run.progress.max_cost_usd)} limit. ${STOP_CONFIRM_TEXT}`,
  };
}

export type BannerTone = "needs" | "fail";

export function incompleteBanner(run: Pick<EvalRunDetail, "status" | "status_reason" | "progress">): {
  tone: BannerTone;
  text: string;
} | null {
  if (run.status === "budget_stopped") {
    return { tone: "needs", text: `Reached the ${formatLimit(run.progress.max_cost_usd)} cost limit. Results are partial.` };
  }
  if (run.status === "failed") {
    return { tone: "fail", text: run.status_reason?.trim() || "The run failed. Results are partial." };
  }
  if (run.status === "cancelled") {
    return { tone: "needs", text: "The run was stopped. Results are partial." };
  }
  return null;
}

export type FinishRoute =
  | { kind: "stay" }
  | { kind: "results"; banner: ReturnType<typeof incompleteBanner> }
  | { kind: "compare"; a: number; b: number };

export function decideFinish(input: {
  previousStatus: EvalRunStatus | null;
  run: Pick<EvalRunDetail, "status" | "status_reason" | "progress" | "run_number">;
  compareWith: number | null;
}): FinishRoute {
  const { previousStatus, run, compareWith } = input;
  if (previousStatus === null || !isActiveStatus(previousStatus) || isActiveStatus(run.status)) {
    return { kind: "stay" };
  }
  if (run.status === "completed" && compareWith !== null) {
    return { kind: "compare", a: compareWith, b: run.run_number };
  }
  return { kind: "results", banner: incompleteBanner(run) };
}

export function runDatasetPath(run: Pick<EvalRunDetail, "config">): string | null {
  const path = run.config?.dataset?.path ?? run.config?.eval?.definition?.dataset;
  return typeof path === "string" && path !== "" ? path : null;
}

export function liveSubtitle(run: EvalRunDetail, now: number): string {
  const target = run.config?.target ?? {};
  const agentLabel = agentRunLabel(run);
  const stage = target.stage_id ?? target.file ?? null;
  const pipeline =
    typeof target.pipeline_path === "string"
      ? target.pipeline_path.split("/").pop()?.replace(/\.pipeline\.ya?ml$/, "")
      : null;
  const dataset = runDatasetPath(run);
  const repeats = Number(run.config?.settings?.repeats);
  const cases = `${run.progress.cases_total} ${run.progress.cases_total === 1 ? "case" : "cases"}`;
  const withRepeats =
    Number.isInteger(repeats) && repeats > 0
      ? `${cases} × ${repeats} ${repeats === 1 ? "repeat" : "repeats"}`
      : cases;
  const parts: string[] = [];
  const internal = internalAgentLabel(run);
  if (isAgentRun(run) && agentLabel) parts.push(agentLabel);
  else if (internal) parts.push(internal);
  else if (stage) parts.push(pipeline ? `Stage ${stage} in ${pipeline}` : `Stage ${stage}`);
  const model = targetModelOf(run);
  if (model) parts.push(model);
  parts.push(dataset ? `${datasetName(dataset)}, ${withRepeats}` : withRepeats);
  const elapsed = elapsedMs(run, now);
  parts.push(elapsed === null ? "waiting to start" : `started ${formatDuration(elapsed)} ago`);
  return parts.join(" · ");
}

export function compareIntentKey(evalId: string, runNumber: number): string {
  return `sf.evals.compareWith.${evalId}.${runNumber}`;
}

export function parseCompareIntent(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}
