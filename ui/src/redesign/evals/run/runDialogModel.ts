import type {
  EvalDatasetCase,
  EvalDetail,
  EvalRunEstimate,
  EvalRunOptions,
  EvalStartRunInput,
} from "../../../api/evalTypes";
import { datasetName } from "../evalListModel";
import { formatDuration } from "../format";

export const DEFAULT_REPEATS = 3;
export const DEFAULT_MAX_COST_USD = 2;
export const MIN_REPEATS = 1;
export const MAX_REPEATS = 10;
export const FOOTER_NOTE = "Runs on this machine with your connected providers.";
export const STAGE_MODEL_HELPER = "Try another model without editing the stage";
export const JUDGE_SAME_HINT = "Same model as the stage. Pick another to avoid self-preference.";
export const NO_COST_HISTORY = "No cost history yet; the limit still applies";
export const NO_PREVIOUS_RUN = "No previous run to base this on";
export const EXCLUDES_JUDGE = "Estimate excludes judge calls.";

export type CasesMode = "all" | "failed" | "pick";

export type LastCompletedRun = { evalRunId: string; runNumber: number; failedCases: number | null };

export type RunDialogContext = {
  evalId: string;
  projectRoot?: string;
  title: string;
  subtitle: string;
  casesTotal: number;
  defaults: { repeats: number; maxCostUsd: number; stageModel: string | null; judge: string | null };
  lastCompleted: LastCompletedRun | null;
};

export type RunDialogState = {
  casesMode: CasesMode;
  picked: string[];
  repeats: string;
  costLimit: string;
  stageModel: string | null;
  judgeModel: string | null;
  compare: boolean;
};

export type RunDialogErrors = { repeats?: string; costLimit?: string; picked?: string };

export function datasetIdOf(datasetPath: string): string {
  return datasetName(datasetPath);
}

export function formatLimit(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function buildContext(input: {
  evalId: string;
  projectRoot?: string;
  detail: EvalDetail;
  casesTotal: number | null;
  lastCompleted: LastCompletedRun | null;
  lastRunConfig?: Record<string, any> | null;
}): RunDialogContext {
  const { detail, lastRunConfig } = input;
  const def = detail.definition;
  const stageLabel = def?.target.kind === "agent" ? def.target.agent : (def?.target.stage ?? def?.target.file ?? "—");
  const datasetLabel = def ? datasetIdOf(def.dataset) : "—";
  const graders = def?.graders.length ?? 0;
  const model = def?.defaults?.model ?? lastRunConfig?.target?.model ?? null;
  const judge = def?.defaults?.judge ?? lastRunConfig?.settings?.judge ?? null;
  return {
    evalId: input.evalId,
    projectRoot: input.projectRoot,
    title: `Run ${input.evalId}`,
    subtitle: `Stage ${stageLabel} · dataset ${datasetLabel} · ${graders} ${graders === 1 ? "grader" : "graders"}`,
    casesTotal: input.casesTotal ?? 0,
    defaults: {
      repeats: def?.defaults?.repeats ?? DEFAULT_REPEATS,
      maxCostUsd: def?.defaults?.max_cost_usd ?? DEFAULT_MAX_COST_USD,
      stageModel: typeof model === "string" && model !== "" ? model : null,
      judge: typeof judge === "string" && judge !== "" ? judge : null,
    },
    lastCompleted: input.lastCompleted,
  };
}

export function initialState(ctx: RunDialogContext): RunDialogState {
  return {
    casesMode: "all",
    picked: [],
    repeats: String(ctx.defaults.repeats),
    costLimit: ctx.defaults.maxCostUsd.toFixed(2),
    stageModel: null,
    judgeModel: null,
    compare: ctx.lastCompleted !== null,
  };
}

export function parseRepeats(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MIN_REPEATS && n <= MAX_REPEATS ? n : null;
}

export function parseCostLimit(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function validate(state: RunDialogState, ctx: RunDialogContext): RunDialogErrors {
  const errors: RunDialogErrors = {};
  if (parseRepeats(state.repeats) === null) errors.repeats = `Enter a whole number from ${MIN_REPEATS} to ${MAX_REPEATS}.`;
  if (parseCostLimit(state.costLimit) === null) errors.costLimit = "Enter an amount above $0.";
  if (state.casesMode === "pick" && state.picked.length === 0) errors.picked = "Pick at least one case.";
  if (state.casesMode === "failed" && ctx.lastCompleted === null) {
    errors.picked = "No completed run to take failed cases from.";
  }
  return errors;
}

export function isValid(state: RunDialogState, ctx: RunDialogContext): boolean {
  return Object.keys(validate(state, ctx)).length === 0;
}

export function casesOptions(
  ctx: RunDialogContext,
  state: RunDialogState,
): Array<{ id: CasesMode; label: string; disabled: boolean }> {
  const last = ctx.lastCompleted;
  const count = last?.failedCases;
  return [
    { id: "all", label: `All ${ctx.casesTotal}`, disabled: false },
    {
      id: "failed",
      label: count === null || count === undefined ? "Failed last time" : `Failed last time · ${count}`,
      disabled: last === null,
    },
    {
      id: "pick",
      label: state.casesMode === "pick" && state.picked.length > 0 ? `Pick cases · ${state.picked.length}` : "Pick cases",
      disabled: false,
    },
  ];
}

export function buildOptions(state: RunDialogState, ctx: RunDialogContext): EvalRunOptions {
  const options: EvalRunOptions = {};
  const repeats = parseRepeats(state.repeats);
  if (repeats !== null && repeats !== ctx.defaults.repeats) options.repeats = repeats;
  const cost = parseCostLimit(state.costLimit);
  if (cost !== null && cost !== ctx.defaults.maxCostUsd) options.max_cost_usd = cost;
  if (state.stageModel !== null && state.stageModel !== "") options.model = state.stageModel;
  if (state.judgeModel !== null && state.judgeModel !== "") options.judge = state.judgeModel;
  if (state.casesMode === "pick") options.case_ids = [...state.picked];
  if (state.casesMode === "failed" && ctx.lastCompleted) options.only_failed_from = ctx.lastCompleted.evalRunId;
  return options;
}

export function buildStartRequest(state: RunDialogState, ctx: RunDialogContext): EvalStartRunInput {
  return { ...buildOptions(state, ctx), ...(ctx.projectRoot ? { project_root: ctx.projectRoot } : {}) };
}

export function buildEstimateRequest(
  state: RunDialogState,
  ctx: RunDialogContext,
): (EvalRunOptions & { project_root?: string }) | null {
  if (!isValid(state, ctx)) return null;
  return { ...buildOptions(state, ctx), ...(ctx.projectRoot ? { project_root: ctx.projectRoot } : {}) };
}

export function estimateKey(request: ReturnType<typeof buildEstimateRequest>): string {
  return request === null ? "" : JSON.stringify(request);
}

export function judgeSameAsStage(state: RunDialogState, ctx: RunDialogContext): boolean {
  const stage = state.stageModel ?? ctx.defaults.stageModel;
  const judge = state.judgeModel ?? ctx.defaults.judge;
  return stage !== null && judge !== null && stage === judge;
}

export function stageDefaultLabel(ctx: RunDialogContext): string {
  return ctx.defaults.stageModel ? `Stage default · ${ctx.defaults.stageModel}` : "Stage default";
}

export function judgeDefaultLabel(ctx: RunDialogContext): string {
  return ctx.defaults.judge ? `Eval default · ${ctx.defaults.judge}` : "Eval default";
}

export function compareLabel(ctx: RunDialogContext): string | null {
  return ctx.lastCompleted ? `Compare with Run #${ctx.lastCompleted.runNumber} when it finishes` : null;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type EstimateText = { headline: string; detail: string; notes: string[]; stops: string };

export function estimateText(estimate: EvalRunEstimate, limitUsd: number): EstimateText {
  const parts: string[] = [];
  if (estimate.estimate_usd !== null) {
    parts.push(
      estimate.estimate_usd > 0 && estimate.estimate_usd < 0.01 ? "< $0.01" : `$${estimate.estimate_usd.toFixed(2)}`,
    );
  }
  if (estimate.estimate_seconds !== null) parts.push(formatDuration(estimate.estimate_seconds * 1000));
  const notes: string[] = [];
  let headline: string;
  if (parts.length === 0) {
    headline = NO_COST_HISTORY;
  } else {
    headline = `About ${parts.join(" and ")}`;
    if (estimate.estimate_usd === null) notes.push(NO_COST_HISTORY);
    else if (!estimate.judge_included) notes.push(EXCLUDES_JUDGE);
  }
  const calls =
    estimate.judge_calls > 0
      ? `${count(estimate.stage_calls, "stage call", "stage calls")} and ${count(estimate.judge_calls, "judge call", "judge calls")}`
      : count(estimate.stage_calls, "stage call", "stage calls");
  const detail =
    estimate.based_on_run_number !== null
      ? `${calls}, based on run #${estimate.based_on_run_number}`
      : `${calls}. ${NO_PREVIOUS_RUN}`;
  return { headline, detail, notes, stops: `stops at ${formatLimit(limitUsd)}` };
}

export function filterPickCases(cases: EvalDatasetCase[], query: string): EvalDatasetCase[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return cases;
  return cases.filter((c) =>
    [c.id, c.title ?? "", JSON.stringify(c.input ?? {})].join("\n").toLowerCase().includes(needle),
  );
}

export function caseLabel(c: Pick<EvalDatasetCase, "title" | "input">): string {
  if (c.title) return c.title;
  const json = JSON.stringify(c.input ?? {});
  return json.length > 90 ? `${json.slice(0, 89)}…` : json;
}

export function togglePicked(picked: string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
}

export function startErrorText(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : "The run could not be started.";
}

export function modelOptions(
  models: Array<{ id: string; judge_capable?: boolean }>,
  defaultLabel: string,
  forJudge: boolean,
): Array<{ value: string; label: string }> {
  const list = models.filter((m) => !forJudge || m.judge_capable !== false);
  return [{ value: "", label: defaultLabel }, ...list.map((m) => ({ value: m.id, label: m.id }))];
}
