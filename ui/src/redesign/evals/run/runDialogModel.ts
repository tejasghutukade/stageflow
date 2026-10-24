import type {
  EvalRunListItem,
  EvalConversation,
  EvalConversationApprovals,
  EvalConversationTools,
  EvalDatasetCase,
  EvalDetail,
  EvalRunEstimate,
  EvalRunOptions,
  EvalSaferApprovals,
  EvalSaferTools,
  EvalStartRunInput,
} from "../../../api/evalTypes";
import { datasetName } from "../evalListModel";
import { formatDuration, formatPercent, formatRelativeTime } from "../format";
import { sortRunsNewestFirst, statusOf, type SwitcherTone } from "./runSwitcherModel";
import { conversationSummary, ROUGH_ESTIMATE } from "../newEval/conversationModel";
import { modeOfCase } from "../datasets/scenarioModel";

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
export const AGENT_DEFAULT_MAX_COST_USD = 1;
export const AGENT_MODEL_HELPER = "Try another model without editing the agent";
export const AGENT_JUDGE_SAME_HINT = "Same model as the agent. Pick another to avoid self-preference.";
export const CONVERSATION_FOOTNOTE = "A conversation that has started always finishes, so the limit can be passed by a little.";
export const REAL_RUN_CONSENT = "I understand this run can change files and call outside services.";
export const CONSENT_REQUIRED = "Tick I understand to run with real tools.";

export type RunAgentInfo = {
  id: string;
  name: string;
  revision: number;
  model: string | null;
  conversation: EvalConversation;
  /** The eval file's default for the simulator, else the judge. */
  userModel: string | null;
  anySimulated: boolean;
};

export type CasesMode = "all" | "failed" | "pick";

export type LastCompletedRun = { evalRunId: string; runNumber: number; failedCases: number | null };

export type BaselineRun = {
  runNumber: number;
  /** Only a completed run can be compared with. */
  selectable: boolean;
  /** Why a run cannot be picked. */
  reason: string | null;
  statusText: string;
  tone: SwitcherTone;
  passRate: string;
  timeText: string;
  label: string | null;
};

export const BASELINE_NOT_COMPLETED = "Only completed runs can be compared";

export function baselineRuns(items: readonly EvalRunListItem[], now = Date.now()): BaselineRun[] {
  return sortRunsNewestFirst(items).map((item) => {
    const status = statusOf(item);
    const selectable = item.status === "completed";
    return {
      runNumber: item.run_number,
      selectable,
      reason: selectable ? null : `${status.text}. ${BASELINE_NOT_COMPLETED}`,
      statusText: status.text,
      tone: status.tone,
      passRate: item.status === "completed" ? formatPercent(item.pass_rate) : "—",
      timeText: formatRelativeTime(item.finished_at ?? item.started_at ?? item.created_at ?? null, now),
      label: item.label,
    };
  });
}

/** The newest completed earlier run, or null. */
export function defaultBaseline(runs: readonly BaselineRun[]): number | null {
  return runs.find((r) => r.selectable)?.runNumber ?? null;
}

export function baselineSublabel(run: BaselineRun): string {
  return [run.timeText, run.label].filter((p): p is string => !!p && p !== "—").join(" · ");
}

export type RunDialogContext = {
  evalId: string;
  projectRoot?: string;
  title: string;
  subtitle: string;
  casesTotal: number;
  defaults: { repeats: number; maxCostUsd: number; stageModel: string | null; judge: string | null };
  lastCompleted: LastCompletedRun | null;
  /** Earlier runs of this eval, newest first. */
  earlierRuns: BaselineRun[];
  /** Present for agent evals. */
  agent?: RunAgentInfo;
};

export type RunDialogState = {
  casesMode: CasesMode;
  picked: string[];
  repeats: string;
  costLimit: string;
  stageModel: string | null;
  judgeModel: string | null;
  compare: boolean;
  /** The earlier run to compare with; `null` until chosen means the default. */
  compareWith: number | null;
  /** Agent evals: `null` is the eval's setting. */
  userModel?: string | null;
  tools?: EvalSaferTools | null;
  approvals?: EvalSaferApprovals | null;
  consent?: boolean;
};

export type RunDialogErrors = { repeats?: string; costLimit?: string; picked?: string; consent?: string };

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
  earlierRuns?: BaselineRun[];
  lastRunConfig?: Record<string, any> | null;
  cases?: ReadonlyArray<Pick<EvalDatasetCase, "input">>;
}): RunDialogContext {
  const { detail, lastRunConfig } = input;
  const def = detail.definition;
  const isAgent = def?.target.kind === "agent";
  const stageLabel = def?.target.kind === "agent" ? def.target.agent : (def?.target.stage ?? def?.target.file ?? "—");
  const datasetLabel = def ? datasetIdOf(def.dataset) : "—";
  const graders = def?.graders.length ?? 0;
  const live = detail.agent ?? null;
  const model = def?.defaults?.model ?? (isAgent ? (live?.model ?? null) : null) ?? lastRunConfig?.target?.model ?? null;
  const judge = def?.defaults?.judge ?? lastRunConfig?.settings?.judge ?? null;
  const conversation: EvalConversation = def?.conversation ?? {};
  const defaultMode = conversation.mode ?? "script";
  const userModel = def?.defaults?.user_model ?? (typeof judge === "string" && judge !== "" ? judge : null);
  const agentName = live?.name ?? stageLabel;
  const agent: RunAgentInfo | undefined = isAgent
    ? {
        id: stageLabel,
        name: agentName,
        revision: live?.revision ?? 0,
        model: live?.model ?? null,
        conversation,
        userModel,
        anySimulated: defaultMode === "simulated" || (input.cases ?? []).some((c) => modeOfCase(c, defaultMode) === "simulated"),
      }
    : undefined;
  return {
    evalId: input.evalId,
    projectRoot: input.projectRoot,
    title: `Run ${input.evalId}`,
    subtitle: agent
      ? `Agent ${agentName}${live ? ` · r${live.revision}` : ""} · dataset ${datasetLabel} · ${graders} ${graders === 1 ? "grader" : "graders"}`
      : `Stage ${stageLabel} · dataset ${datasetLabel} · ${graders} ${graders === 1 ? "grader" : "graders"}`,
    casesTotal: input.casesTotal ?? 0,
    defaults: {
      repeats: def?.defaults?.repeats ?? DEFAULT_REPEATS,
      maxCostUsd: def?.defaults?.max_cost_usd ?? (isAgent ? AGENT_DEFAULT_MAX_COST_USD : DEFAULT_MAX_COST_USD),
      stageModel: typeof model === "string" && model !== "" ? model : null,
      judge: typeof judge === "string" && judge !== "" ? judge : null,
    },
    lastCompleted: input.lastCompleted,
    earlierRuns: input.earlierRuns ?? [],
    ...(agent ? { agent } : {}),
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
    compareWith: compareBaseline({ compareWith: null }, ctx),
    ...(ctx.agent ? { userModel: null, tools: null, approvals: null, consent: false } : {}),
  };
}

export function effectiveTools(state: RunDialogState, ctx: RunDialogContext): EvalConversationTools {
  return state.tools ?? ctx.agent?.conversation.tools ?? "read_only";
}

export function effectiveApprovals(state: RunDialogState, ctx: RunDialogContext): EvalConversationApprovals {
  return state.approvals ?? ctx.agent?.conversation.approvals ?? "record_only";
}

/** Real tools need the per-run consent; the dialog blocks Run until it is ticked. */
export function needsConsent(state: RunDialogState, ctx: RunDialogContext): boolean {
  return ctx.agent !== undefined && effectiveTools(state, ctx) === "real";
}

export type SelectOption = { value: string; label: string };

/** Run overrides can only be safer than the eval's setting: real, then read only, then mocked. */
export function saferToolsOptions(ctx: RunDialogContext): SelectOption[] {
  const current = ctx.agent?.conversation.tools ?? "read_only";
  const options: SelectOption[] = [{ value: "", label: "Eval setting" }];
  if (current === "real") options.push({ value: "read_only", label: "Read only" }, { value: "mocked", label: "Mocked" });
  if (current === "read_only") options.push({ value: "mocked", label: "Mocked" });
  return options;
}

/** Approvals: auto-approve reads, then record only, then deny. */
export function saferApprovalsOptions(ctx: RunDialogContext): SelectOption[] {
  const current = ctx.agent?.conversation.approvals ?? "record_only";
  const options: SelectOption[] = [{ value: "", label: "Eval setting" }];
  if (current === "auto_approve_read") options.push({ value: "record_only", label: "Record only" }, { value: "deny", label: "Deny" });
  if (current === "record_only") options.push({ value: "deny", label: "Deny" });
  return options;
}

export function conversationLine(ctx: RunDialogContext, state: RunDialogState): string | null {
  if (!ctx.agent) return null;
  return conversationSummary({ ...ctx.agent.conversation, tools: effectiveTools(state, ctx), approvals: effectiveApprovals(state, ctx) });
}

export function userModelDefaultLabel(ctx: RunDialogContext): string {
  return ctx.agent?.userModel ? `Eval default · ${ctx.agent.userModel}` : "Eval default";
}

export function agentDefaultLabel(ctx: RunDialogContext): string {
  return ctx.defaults.stageModel ? `Agent default · ${ctx.defaults.stageModel}` : "Agent default";
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
  if (needsConsent(state, ctx) && state.consent !== true) errors.consent = CONSENT_REQUIRED;
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
  if (ctx.agent) {
    if (state.userModel) options.user_model = state.userModel;
    if (state.tools) options.tools = state.tools;
    if (state.approvals) options.approvals = state.approvals;
  }
  return options;
}

export function buildStartRequest(state: RunDialogState, ctx: RunDialogContext): EvalStartRunInput {
  return {
    ...buildOptions(state, ctx),
    ...(needsConsent(state, ctx) && state.consent === true ? { allow_real_tools: true } : {}),
    ...(ctx.projectRoot ? { project_root: ctx.projectRoot } : {}),
  };
}

export function buildEstimateRequest(
  state: RunDialogState,
  ctx: RunDialogContext,
): (EvalRunOptions & { project_root?: string }) | null {
  const { consent: _consent, ...errors } = validate(state, ctx);
  void _consent;
  if (Object.keys(errors).length > 0) return null;
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

/** The run number the finished run is compared with: the chosen one if still valid, else the default. */
export function compareBaseline(state: Pick<RunDialogState, "compareWith">, ctx: RunDialogContext): number | null {
  const chosen = ctx.earlierRuns.find((r) => r.runNumber === state.compareWith && r.selectable);
  if (chosen) return chosen.runNumber;
  return defaultBaseline(ctx.earlierRuns) ?? ctx.lastCompleted?.runNumber ?? null;
}

/** The chooser shows only when there is more than one earlier run to pick from. */
export function showBaselineChooser(ctx: RunDialogContext): boolean {
  return ctx.earlierRuns.length > 1 && ctx.earlierRuns.some((r) => r.selectable);
}

export function compareLabel(ctx: RunDialogContext): string | null {
  return ctx.lastCompleted ? `Compare with Run #${ctx.lastCompleted.runNumber} when it finishes` : null;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type EstimateText = { headline: string; detail: string; notes: string[]; stops: string; footnote?: string };

function agentDetail(estimate: EvalRunEstimate): string {
  const conversations = count(estimate.stage_calls, "conversation", "conversations");
  const simulator = count(estimate.simulator_calls ?? 0, "simulator call", "simulator calls");
  const judge = count(estimate.judge_calls, "judge call", "judge calls");
  const calls = estimate.judge_calls > 0 ? `${conversations}, ${simulator} and ${judge}` : `${conversations} and ${simulator}`;
  if (estimate.estimate_basis === "assumptions") return `${calls}. ${ROUGH_ESTIMATE}`;
  return estimate.based_on_run_number !== null ? `${calls}, based on run #${estimate.based_on_run_number}` : `${calls}. ${NO_PREVIOUS_RUN}`;
}

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
  if (estimate.target_kind === "agent") {
    return { headline, detail: agentDetail(estimate), notes, stops: `stops at ${formatLimit(limitUsd)}`, footnote: CONVERSATION_FOOTNOTE };
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

export function caseLabel(c: Pick<EvalDatasetCase, "title" | "input">, agent = false): string {
  if (c.title) return c.title;
  const input = (c.input ?? {}) as { opening?: unknown; script?: unknown };
  const first = typeof input.opening === "string" ? input.opening : Array.isArray(input.script) && typeof input.script[0] === "string" ? input.script[0] : null;
  if (agent && first !== null && first !== "") return first.length > 90 ? `${first.slice(0, 89)}…` : first;
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

export type PickerOption = {
  value: string;
  label: string;
  group?: string;
  /** Muted text after the label. */
  sublabel?: string;
  chip?: { text: string; tone: SwitcherTone };
  meta?: string;
  disabled?: boolean;
  reason?: string;
  /** The first option that stands for "no override". */
  isDefault?: boolean;
};

export const JUDGE_ONLY_HINT = "Judge-capable models only";

export function modelPickerOptions(
  models: Array<{ id: string; provider?: string; name?: string; judge_capable?: boolean }>,
  defaultLabel: string,
  forJudge: boolean,
): PickerOption[] {
  const list = models.filter((m) => !forJudge || m.judge_capable !== false);
  const providerOf = (m: { id: string; provider?: string }) => m.provider ?? (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "other");
  const tail = (id: string) => (id.indexOf("/") > 0 ? id.slice(id.indexOf("/") + 1) : id);
  const sorted = [...list].sort((a, b) => providerOf(a).localeCompare(providerOf(b)));
  return [
    { value: "", label: defaultLabel, isDefault: true },
    ...sorted.map((m) => ({
      value: m.id,
      label: m.name && m.name !== "" ? m.name : tail(m.id),
      group: providerOf(m),
      sublabel: tail(m.id),
    })),
  ];
}

export function filterPickerOptions(options: readonly PickerOption[], query: string): PickerOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter(
    (o) => !o.isDefault && [o.label, o.sublabel ?? "", o.value, o.group ?? ""].join("\n").toLowerCase().includes(needle),
  );
}

export function baselinePickerOptions(runs: readonly BaselineRun[]): PickerOption[] {
  return runs.map((r) => ({
    value: String(r.runNumber),
    label: `Run #${r.runNumber}`,
    sublabel: baselineSublabel(r),
    chip: { text: r.statusText, tone: r.tone },
    meta: r.passRate,
    disabled: !r.selectable,
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}

export function nextEnabled(options: readonly PickerOption[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < options.length; i += step) if (!options[i]!.disabled) return i;
  return from;
}

export function edgeEnabled(options: readonly PickerOption[], end: "first" | "last"): number {
  const order = options.map((_, i) => i);
  if (end === "last") order.reverse();
  return order.find((i) => !options[i]!.disabled) ?? -1;
}
