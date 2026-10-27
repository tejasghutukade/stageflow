import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown, LuPlay, LuSearch, LuX } from "react-icons/lu";
import { fetchEvalRunEstimate, startEvalRun, fetchEvalRun } from "../../../api";
import type { EvalRunEstimate } from "../../../api/evalTypes";
import { evalRunPath, navigate } from "../../../routes";
import { RealToolsPanel } from "../newEval/ConversationCard";
import { Keycap } from "../../Keycap";
import { MODAL_SCRIM_PT, OVERLAY_SCRIM_CLASS } from "../../overlay/overlayScrimClasses";
import { useOverlayChrome } from "../../overlay/useOverlayChrome";
import {
  AGENT_JUDGE_SAME_HINT,
  AGENT_MODEL_HELPER,
  CONSENT_REQUIRED,
  REAL_RUN_CONSENT,
  FOOTER_NOTE,
  JUDGE_SAME_HINT,
  STAGE_MODEL_HELPER,
  agentDefaultLabel,
  conversationLine,
  needsConsent,
  saferApprovalsOptions,
  saferToolsOptions,
  userModelDefaultLabel,
  buildEstimateRequest,
  buildStartRequest,
  caseLabel,
  casesOptions,
  compareLabel,
  estimateKey,
  estimateText,
  filterPickCases,
  initialState,
  isValid,
  judgeDefaultLabel,
  judgeSameAsStage,
  modelPickerOptions,
  baselinePickerOptions,
  compareBaseline,
  showBaselineChooser,
  JUDGE_ONLY_HINT,
  parseCostLimit,
  stageDefaultLabel,
  togglePicked,
  validate,
  type RunDialogContext,
  type RunDialogState,
  startErrorText,
} from "./runDialogModel";
import { closeRunDialog, saveCompareIntent, useRunDialogTarget } from "./runDialogStore";
import { RunPicker } from "./RunPicker";
import { useRunDialogData } from "./useRunDialogData";

const MONO = "font-['Geist_Mono',monospace]";
const LABEL = "text-[13px] text-[var(--sf-text-2)]";
const FIELD =
  "h-[34px] w-full rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-ground)] px-3 text-[13px] text-[var(--sf-text-1)] outline-none";
const ESTIMATE_DEBOUNCE_MS = 300;

export function RunDialogHost() {
  const target = useRunDialogTarget();
  if (!target) return null;
  return <RunDialog key={`${target.projectRoot ?? ""}\0${target.evalId}`} />;
}

function Select({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <span className="relative block">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${FIELD} ${MONO} appearance-none pr-8`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <LuChevronDown
        className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--sf-text-2)]"
        aria-hidden
      />
    </span>
  );
}

function RunDialog() {
  const target = useRunDialogTarget();
  const data = useRunDialogData(target);
  useOverlayChrome(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRunDialog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return createPortal(
    <div className={`${OVERLAY_SCRIM_CLASS} ${MODAL_SCRIM_PT}`} role="presentation" onClick={() => closeRunDialog()}>
      <div
        className="flex w-[640px] min-w-0 max-h-[min(900px,calc(100vh-2.75rem))] flex-col overflow-clip rounded-[14px] border border-[#ffffff1a] bg-[var(--sf-panel)] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-run-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        {data.status === "ready" ? (
          <RunDialogForm ctx={data.ctx} cases={data.cases} models={data.models} />
        ) : (
          <>
            <header className="flex items-start justify-between gap-3 px-5 pb-3.5 pt-[18px]">
              <h2 id="sf-run-dialog-title" className="text-lg font-semibold tracking-[-0.36px] text-[var(--sf-text-1)]">
                Run {target?.evalId}
              </h2>
              <CloseButton />
            </header>
            <div className="border-t border-t-[var(--sf-hairline)] px-5 py-8 text-[13px]">
              {data.status === "loading" ? (
                <span className="text-[var(--sf-text-3)]">Loading…</span>
              ) : (
                <span className="text-[var(--sf-fail)]" role="alert">
                  {data.message}
                </span>
              )}
            </div>
            <footer className="flex justify-end border-t border-t-[var(--sf-hairline)] px-5 py-3.5">
              <button
                type="button"
                onClick={() => closeRunDialog()}
                className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
              >
                Close
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function CloseButton() {
  return (
    <div className="flex shrink-0 items-center gap-2 pt-0.5">
      <Keycap className="text-[var(--sf-text-3)]">esc</Keycap>
      <button type="button" className="flex size-7 items-center justify-center rounded-lg" onClick={() => closeRunDialog()} aria-label="Close">
        <LuX className="size-4 text-[var(--sf-text-2)]" aria-hidden />
      </button>
    </div>
  );
}

function RunDialogForm({
  ctx,
  cases,
  models,
}: {
  ctx: RunDialogContext;
  cases: import("../../../api/evalTypes").EvalDatasetCase[];
  models: Array<{ id: string; judge_capable?: boolean }>;
}) {
  const [state, setState] = useState<RunDialogState>(() => initialState(ctx));
  const [pickQuery, setPickQuery] = useState("");
  const [estimate, setEstimate] = useState<EvalRunEstimate | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const errors = validate(state, ctx);
  const valid = isValid(state, ctx);
  const agent = ctx.agent;
  const consentNeeded = needsConsent(state, ctx);
  const conversation = conversationLine(ctx, state);
  const toolsOptions = saferToolsOptions(ctx);
  const approvalsOptions = saferApprovalsOptions(ctx);
  const request = useMemo(() => buildEstimateRequest(state, ctx), [state, ctx]);
  const key = estimateKey(request);

  useEffect(() => {
    if (request === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchEvalRunEstimate(ctx.evalId, request).then(
        (next) => {
          if (cancelled) return;
          setEstimate(next);
          setEstimateFailed(false);
        },
        () => {
          if (!cancelled) setEstimateFailed(true);
        },
      );
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ctx.evalId]);

  function patch(next: Partial<RunDialogState>) {
    setState((s) => ({ ...s, ...next }));
    setStartError(null);
  }

  async function submit() {
    if (!valid || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const started = await startEvalRun(ctx.evalId, buildStartRequest(state, ctx));
      let runNumber = started.run_number;
      if (runNumber === undefined) runNumber = (await fetchEvalRun(started.eval_run_id)).run_number;
      if (state.compare) {
        const picked = compareBaseline(state, ctx);
        if (picked !== null) saveCompareIntent(ctx.evalId, runNumber, picked);
      }
      closeRunDialog();
      navigate(evalRunPath(ctx.evalId, runNumber));
    } catch (err) {
      setStartError(startErrorText(err));
      setStarting(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const visibleCases = filterPickCases(cases, pickQuery);
  const limit = parseCostLimit(state.costLimit);
  const text = estimate && limit !== null ? estimateText(estimate, limit) : null;
  const compare = compareLabel(ctx);
  const sameHint = judgeSameAsStage(state, ctx);
  const chooser = showBaselineChooser(ctx);
  const baseline = compareBaseline(state, ctx);

  return (
    <>
      <header className="flex w-full shrink-0 items-start gap-3 px-5 pb-3.5 pt-[18px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2
            id="sf-run-dialog-title"
            ref={titleRef}
            tabIndex={-1}
            className="truncate text-lg font-semibold tracking-[-0.36px] text-[var(--sf-text-1)] outline-none"
          >
            {ctx.title}
          </h2>
          <p className="truncate text-[13px] text-[var(--sf-text-2)]">{ctx.subtitle}</p>
        </div>
        <CloseButton />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-t-[var(--sf-hairline)] px-5 py-4">
        <section className="flex flex-col gap-2">
          <span className={LABEL}>Which cases</span>
          <div className="flex rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-ground)] p-[3px]" role="tablist" aria-label="Which cases">
            {casesOptions(ctx, state).map((option) => {
              const active = state.casesMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={option.disabled}
                  onClick={() => patch({ casesMode: option.id })}
                  className={`h-7 flex-1 rounded-md text-[13px] ${
                    active ? "bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"
                  } ${option.disabled ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {state.casesMode === "pick" ? (
            <div className="flex flex-col overflow-clip rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-ground)]">
              <label className="flex h-9 items-center gap-2 border-b border-b-[var(--sf-hairline)] px-3">
                <LuSearch className="size-3.5 text-[var(--sf-text-3)]" aria-hidden />
                <input
                  type="search"
                  value={pickQuery}
                  onChange={(e) => setPickQuery(e.target.value)}
                  placeholder="Search cases by id, title or input"
                  className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
                />
                <button
                  type="button"
                  className="text-xs text-[var(--sf-text-2)] underline"
                  onClick={() => patch({ picked: visibleCases.map((c) => c.id) })}
                >
                  Select shown
                </button>
                <button type="button" className="text-xs text-[var(--sf-text-2)] underline" onClick={() => patch({ picked: [] })}>
                  Clear
                </button>
              </label>
              <div className="max-h-[200px] overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label="Cases">
                {visibleCases.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-[var(--sf-text-3)]">
                    {cases.length === 0 ? "No cases found in the dataset." : "No cases match."}
                  </p>
                ) : (
                  visibleCases.map((c) => {
                    const checked = state.picked.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected={checked}
                        onClick={() => patch({ picked: togglePicked(state.picked, c.id) })}
                        className="flex w-full items-center gap-2.5 border-t border-t-[var(--sf-hairline)] px-3 py-1.5 text-left first:border-t-0"
                      >
                        <span
                          className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${
                            checked
                              ? "border-[var(--sf-text-1)] bg-[var(--sf-text-1)]"
                              : "border-[var(--sf-hairline-strong)]"
                          }`}
                        >
                          {checked ? <LuCheck className="size-3 text-[var(--sf-ground)]" aria-hidden /> : null}
                        </span>
                        <span className={`${MONO} w-[56px] shrink-0 truncate text-xs text-[var(--sf-text-2)]`}>{c.id}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--sf-text-1)]">{caseLabel(c, agent !== undefined)}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}
          {errors.picked ? (
            <p className="text-xs text-[var(--sf-fail)]" role="alert">
              {errors.picked}
            </p>
          ) : null}
        </section>

        <section className="grid grid-cols-2 gap-x-3 gap-y-4">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Repeats per case</span>
            <input
              inputMode="numeric"
              value={state.repeats}
              onChange={(e) => patch({ repeats: e.target.value })}
              aria-invalid={errors.repeats ? true : undefined}
              className={`${FIELD} ${MONO}`}
            />
            {errors.repeats ? <span className="text-xs text-[var(--sf-fail)]">{errors.repeats}</span> : null}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Cost limit</span>
            <input
              inputMode="decimal"
              value={state.costLimit}
              onChange={(e) => patch({ costLimit: e.target.value })}
              aria-invalid={errors.costLimit ? true : undefined}
              className={`${FIELD} ${MONO}`}
              placeholder="$2.00"
            />
            {errors.costLimit ? <span className="text-xs text-[var(--sf-fail)]">{errors.costLimit}</span> : null}
          </label>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{agent ? "Agent model" : "Stage model"}</span>
            <RunPicker
              searchable
              ariaLabel={agent ? "Agent model" : "Stage model"}
              value={state.stageModel ?? ""}
              options={modelPickerOptions(models, agent ? agentDefaultLabel(ctx) : stageDefaultLabel(ctx), false)}
              onChange={(v) => patch({ stageModel: v === "" ? null : v })}
            />
            <span className="text-xs text-[var(--sf-text-3)]">{agent ? AGENT_MODEL_HELPER : STAGE_MODEL_HELPER}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Judge model</span>
            <RunPicker
              searchable
              ariaLabel="Judge model"
              value={state.judgeModel ?? ""}
              options={modelPickerOptions(models, judgeDefaultLabel(ctx), true)}
              onChange={(v) => patch({ judgeModel: v === "" ? null : v })}
            />
            {sameHint ? <span className="text-xs text-[var(--sf-needs)]">{agent ? AGENT_JUDGE_SAME_HINT : JUDGE_SAME_HINT}</span> : null}
          </div>
          {agent?.anySimulated ? (
            <div className="flex flex-col gap-1.5">
              <span className={LABEL}>User model</span>
              <RunPicker
                searchable
                ariaLabel="User model"
                hint={JUDGE_ONLY_HINT}
                value={state.userModel ?? ""}
                options={modelPickerOptions(models, userModelDefaultLabel(ctx), true)}
                onChange={(v) => patch({ userModel: v === "" ? null : v })}
              />
              <span className="text-xs text-[var(--sf-text-3)]">Plays the user. Costs tokens on every turn.</span>
            </div>
          ) : null}
        </section>

        {agent ? (
          <section className="flex flex-col gap-3" aria-label="Conversation">
            <p className={`${MONO} rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-3 py-2 text-xs text-[var(--sf-text-2)]`}>{conversation}</p>
            {toolsOptions.length > 1 || approvalsOptions.length > 1 ? (
              <div className="grid grid-cols-2 gap-x-3">
                {toolsOptions.length > 1 ? (
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>Tools for this run</span>
                    <Select
                      label="Tools for this run"
                      value={state.tools ?? ""}
                      options={toolsOptions}
                      onChange={(v) => patch({ tools: v === "" ? null : (v as "read_only" | "mocked"), consent: false })}
                    />
                  </div>
                ) : null}
                {approvalsOptions.length > 1 ? (
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL}>Approvals for this run</span>
                    <Select
                      label="Approvals for this run"
                      value={state.approvals ?? ""}
                      options={approvalsOptions}
                      onChange={(v) => patch({ approvals: v === "" ? null : (v as "deny" | "record_only") })}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {consentNeeded ? (
              <div className="flex flex-col gap-2">
                <RealToolsPanel checked={state.consent === true} onChange={(v) => patch({ consent: v })} label={REAL_RUN_CONSENT} blockedNote={CONSENT_REQUIRED} />
              </div>
            ) : null}
          </section>
        ) : null}

        {compare ? (
          <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-[var(--sf-text-1)]">
            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={state.compare}
                onChange={(e) => patch({ compare: e.target.checked })}
                className="size-4 accent-[var(--sf-text-1)]"
              />
              {chooser ? "Compare with" : compare}
            </label>
            {chooser ? (
              <>
                <RunPicker
                  compact
                  ariaLabel="Run to compare with"
                  value={String(baseline ?? "")}
                  options={baselinePickerOptions(ctx.earlierRuns)}
                  onChange={(v) => patch({ compareWith: Number(v), compare: true })}
                />
                <span>when it finishes</span>
              </>
            ) : null}
          </div>
        ) : null}

        <section
          className="flex items-center justify-between gap-4 rounded-[10px] border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-4 py-3"
          aria-live="polite"
        >
          {text ? (
            <>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-[var(--sf-text-1)]">{text.headline}</p>
                <p className="mt-0.5 text-xs text-[var(--sf-text-2)]">
                  {text.detail}
                  {text.notes.map((note) => ` ${note}`).join("")}
                </p>
                {text.footnote ? <p className="mt-1 text-xs text-[var(--sf-text-3)]">{text.footnote}</p> : null}
              </div>
              <span className={`${MONO} shrink-0 text-xs text-[var(--sf-text-2)]`}>{text.stops}</span>
            </>
          ) : (
            <p className="text-xs text-[var(--sf-text-3)]">
              {request === null ? "Fix the fields above to see an estimate." : estimateFailed ? "No estimate available." : "Estimating…"}
            </p>
          )}
        </section>
      </div>

      <div className="flex w-full shrink-0 flex-col gap-2 border-t border-t-[var(--sf-hairline)] px-5 py-3.5">
        {startError ? (
          <p className="text-[13px] text-[var(--sf-fail)]" role="alert">
            {startError}
          </p>
        ) : null}
        <footer className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 text-xs text-[var(--sf-text-3)]">{FOOTER_NOTE}</span>
          <button
            type="button"
            className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
            onClick={() => closeRunDialog()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)] disabled:opacity-50"
            disabled={!valid || starting}
            title={errors.consent}
            onClick={() => void submit()}
          >
            <LuPlay className="size-[13px]" aria-hidden />
            {starting ? "Starting…" : "Run eval"}
          </button>
        </footer>
      </div>
    </>
  );
}
