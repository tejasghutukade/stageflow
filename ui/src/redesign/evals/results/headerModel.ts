import type { EvalRunDetail, EvalRunStatus } from "../../../api/evalTypes";
import { datasetName } from "../evalListModel";
import { elapsedMs, incompleteBanner, runDatasetPath } from "../run/liveProgressModel";
import { formatDuration, formatPercent, formatRelativeTime } from "../format";
import { agentRunLabel, conversationOf, internalAgentLabel, isAgentRun, isConversationTarget, targetModelOf } from "../agentRun";

export type ResultsTabId = "overview" | "cases" | "graders" | "config";
export type Tone = "ok" | "needs" | "fail" | "muted";

export function settingsOf(run: Pick<EvalRunDetail, "config">): Record<string, any> {
  return (run.config?.settings ?? {}) as Record<string, any>;
}

export function thresholdOf(run: Pick<EvalRunDetail, "config">): number {
  const value = Number(settingsOf(run).pass_threshold);
  return Number.isFinite(value) && value > 0 ? value : 0.8;
}

export function repeatsOf(run: Pick<EvalRunDetail, "config">): number {
  const value = Number(settingsOf(run).repeats);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function hash6(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 6) : "—";
}

export function percentWhole(rate: number): string {
  return `${Number((rate * 100).toFixed(1))}%`;
}

export function capitalize(text: string): string {
  return text === "" ? text : text[0]!.toUpperCase() + text.slice(1);
}

export function suiteTypeLabel(run: Pick<EvalRunDetail, "config">): string {
  const type = settingsOf(run).suite_type;
  return typeof type === "string" && type !== "" ? capitalize(type) : "Capability";
}

const STATUS_CHIP: Record<Exclude<EvalRunStatus, "completed">, { text: string; tone: Tone }> = {
  queued: { text: "Queued", tone: "muted" },
  running: { text: "Running", tone: "muted" },
  failed: { text: "Failed", tone: "fail" },
  cancelled: { text: "Cancelled", tone: "needs" },
  budget_stopped: { text: "Stopped at cost limit", tone: "needs" },
};

export function resultChip(run: EvalRunDetail): { text: string; tone: Tone } {
  if (run.status !== "completed") return STATUS_CHIP[run.status];
  const rate = run.stats?.pass_rate ?? null;
  const threshold = percentWhole(thresholdOf(run));
  if (run.passed) return { text: `Passed · ${formatPercent(rate)} vs ${threshold} threshold`, tone: "ok" };
  return { text: `Below threshold · ${formatPercent(rate)} vs ${threshold}`, tone: "fail" };
}

export function stageLabel(run: Pick<EvalRunDetail, "config">): { stage: string | null; pipeline: string | null } {
  const target = (run.config?.target ?? {}) as Record<string, any>;
  const stage = target.stage_id ?? target.file ?? null;
  const pipeline =
    typeof target.pipeline_path === "string"
      ? (target.pipeline_path.split("/").pop() ?? "").replace(/\.pipeline\.ya?ml$/, "")
      : null;
  return { stage: typeof stage === "string" ? stage : null, pipeline: pipeline || null };
}

export function headerSubtitle(run: EvalRunDetail, now = Date.now()): string {
  const { stage, pipeline } = stageLabel(run);
  const datasetPath = runDatasetPath(run);
  const repeats = repeatsOf(run);
  const cases = run.progress.cases_total;
  const parts: string[] = [];
  const agent = isConversationTarget(run);
  const agentLabel = agentRunLabel(run);
  const internal = internalAgentLabel(run);
  if (isAgentRun(run) && agentLabel) parts.push(agentLabel);
  else if (internal) parts.push(internal);
  else if (stage) parts.push(pipeline ? `Stage ${stage} in ${pipeline}` : `Stage ${stage}`);
  const model = targetModelOf(run);
  if (model) parts.push(model);
  const noun = agent ? (cases === 1 ? "scenario" : "scenarios") : cases === 1 ? "case" : "cases";
  const shape = `${cases} ${noun} × ${repeats} ${repeats === 1 ? "repeat" : "repeats"}`;
  parts.push(datasetPath ? `${datasetName(datasetPath)}, ${shape}` : shape);
  const judge = settingsOf(run).judge;
  if (typeof judge === "string" && judge !== "") parts.push(`judge ${judge}`);
  const userModel = conversationOf(run).user_model;
  if (agent && typeof userModel === "string" && userModel !== "") parts.push(`user ${userModel}`);
  if (run.finished_at) {
    const took = elapsedMs(run, now);
    const rel = formatRelativeTime(run.finished_at, now);
    parts.push(took === null ? `finished ${rel}` : `finished ${rel} in ${formatDuration(took)}`);
  }
  return parts.join(" · ");
}

export function previousRunNumber(runNumbers: number[], current: number): number | null {
  const lower = runNumbers.filter((n) => n < current);
  return lower.length === 0 ? null : Math.max(...lower);
}

export function nextRunNumber(runNumbers: number[], current: number): number | null {
  const higher = runNumbers.filter((n) => n > current);
  return higher.length === 0 ? null : Math.min(...higher);
}

export function runPosition(
  runNumbers: number[],
  current: number,
): { label: string; previous: number | null; next: number | null } {
  const latest = runNumbers.length === 0 ? current : Math.max(current, ...runNumbers);
  return {
    label: `Run #${current} of ${latest}`,
    previous: previousRunNumber(runNumbers, current),
    next: nextRunNumber(runNumbers, current),
  };
}

export function footerText(run: EvalRunDetail): string {
  const target = (run.config?.target ?? {}) as Record<string, any>;
  if (isAgentRun(run)) {
    return `Agent definition ${hash6(target.definition_hash)} · eval file ${run.eval_path} · stored on this machine`;
  }
  return `Stage version ${hash6(target.stage_version_hash)} · eval file ${run.eval_path} · stored on this machine`;
}

export function resultsTabs(
  run: EvalRunDetail,
  casesCount: number | null,
): Array<{ id: ResultsTabId; label: string; count?: number }> {
  const graders = Array.isArray(run.config?.graders) ? run.config.graders.length : 0;
  const cases = casesCount ?? run.stats?.cases_counted ?? run.progress.cases_total;
  return [
    { id: "overview", label: "Overview" },
    { id: "cases", label: "Cases", count: cases },
    { id: "graders", label: "Graders", count: graders },
    { id: "config", label: "Config" },
  ];
}

export function partialBanner(run: EvalRunDetail) {
  return incompleteBanner(run);
}
