import { useEffect, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuCheck, LuExternalLink, LuRefreshCw, LuX } from "react-icons/lu";
import { acceptEvalSuggestions, dismissEvalSuggestions, putEvalReview, tryEvalCase } from "../../../api";
import { suggestionLine } from "./triageModel";
import type { EvalSuggestion, EvalResultDetail, EvalRunDetail, EvalTryResult } from "../../../api/evalTypes";
import { agentRunPath, datasetPath, navigate, runStreamPath } from "../../../routes";
import { isAgentRun } from "../agentRun";
import { usedRealTools } from "./configModel";
import { TranscriptList, TranscriptSection } from "./TranscriptView";
import { errorLabel, expectedChecklist, sessionLink, transcriptView, SESSION_DELETED } from "./transcriptModel";
import { datasetIdOf } from "../run/runDialogModel";
import { runDatasetPath } from "../run/liveProgressModel";
import {
  addNewTag,
  afterSave,
  agreementLine,
  buildSaveRequest,
  canSave,
  caseNeighbours,
  drawerHeader,
  errorView,
  expectedFindings,
  gradeRows,
  initReview,
  inputLines,
  isErrored,
  outputView,
  repeatTabs,
  rerunPanelView,
  selectRepeat,
  setLabel,
  setNote,
  tagsEnabled,
  toggleTag,
  hasTag,
  NOTE_MAX,
  type GradeRowView,
  type ReviewState,
} from "./drawerModel";
import { Chip, MONO_CLASS, TONE_TEXT } from "./ResultsParts";
import { useAgentSession, useCaseResults, useStageRunExists } from "./useResultsData";

const LABEL = "text-[11px] font-medium uppercase tracking-wide text-[var(--sf-text-3)]";

function GradeList({ rows }: { rows: GradeRowView[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
      {rows.map((row, i) => (
        <div
          key={row.id}
          className={`flex flex-col gap-1 px-3 py-2.5 text-[13px] ${i > 0 ? "border-t border-[var(--sf-hairline)]" : ""} ${
            row.failed ? "bg-[var(--sf-fail-bg)]" : ""
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              {row.failed ? (
                <LuX className="size-3.5 text-[var(--sf-fail)]" aria-hidden />
              ) : (
                <LuCheck className="size-3.5 text-[var(--sf-ok)]" aria-hidden />
              )}
              <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{row.id}</span>
            </span>
            <span className={`${MONO_CLASS} ${row.failed ? "text-[var(--sf-fail)]" : "text-[var(--sf-ok)]"}`}>{row.valueText}</span>
          </div>
          {row.reason ? <p className="pl-5 text-xs text-[var(--sf-text-2)]">{row.reason}</p> : null}
        </div>
      ))}
    </div>
  );
}

function SuggestionLine({
  evalRunId,
  suggestion,
  onChanged,
}: {
  evalRunId: string;
  suggestion: EvalSuggestion;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = suggestionLine(suggestion);
  if (suggestion.status === "dismissed") return null;

  async function act(kind: "accept" | "dismiss") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "accept") await acceptEvalSuggestions(evalRunId, { ids: [suggestion.id] });
      else await dismissEvalSuggestions(evalRunId, [suggestion.id]);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`flex flex-col gap-2 rounded-lg border bg-[var(--sf-panel)] px-3 py-2.5 ${
        view.low ? "border-dashed border-[var(--sf-text-3)]" : "border-[var(--sf-hairline)]"
      }`}
      aria-label="Suggested failure sort"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className={`${MONO_CLASS} text-[13px] text-[var(--sf-text-1)]`}>{view.text}</span>
          {view.lowText ? <span className="text-xs italic text-[var(--sf-text-2)]">{view.lowText}</span> : null}
          {view.acceptedNote ? <span className="text-xs text-[var(--sf-text-2)]">{view.acceptedNote}</span> : null}
        </div>
        {view.pending ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act("accept")}
              className="h-7 rounded-lg bg-[var(--sf-text-1)] px-3 text-xs font-medium text-[var(--sf-ground)] disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act("dismiss")}
              className="h-7 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-xs font-medium text-[var(--sf-text-1)] disabled:opacity-50"
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-[var(--sf-fail)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ReviewCard({
  run,
  result,
  vocabulary,
  onSaved,
}: {
  run: EvalRunDetail;
  result: EvalResultDetail;
  vocabulary: string[];
  onSaved: () => void;
}) {
  const [state, setState] = useState<ReviewState>(() => initReview(result));
  const [newTag, setNewTag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  useEffect(() => {
    setState(initReview(result));
    setError(null);
    setSavedAt(false);
    setNewTag(null);
  }, [result.case_id, result.repeat_index, result.review?.label, result.review?.note, result.tags.join("\n")]);

  const enabled = tagsEnabled(result);
  const line = agreementLine(result, state.label);
  const tagChoices = [...vocabulary, ...state.tags.filter((t) => !hasTag(vocabulary, t))];

  async function save() {
    const request = buildSaveRequest(state, result);
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await putEvalReview(run.eval_run_id, result.case_id, result.repeat_index, request);
      setState(afterSave(saved));
      setSavedAt(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)]">
      <header className="border-b border-[var(--sf-hairline)] px-3 py-2 text-[13px] font-semibold text-[var(--sf-text-1)]">Your review</header>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5 text-[13px]" role="group" aria-label="Your verdict">
            {(["pass", "fail"] as const).map((label) => (
              <button
                key={label}
                type="button"
                aria-pressed={state.label === label}
                onClick={() => setState(setLabel(state, label))}
                className={`rounded-md px-3 py-1 ${
                  state.label === label
                    ? label === "fail"
                      ? "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]"
                      : "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]"
                    : "text-[var(--sf-text-2)]"
                }`}
              >
                {label === "pass" ? "Pass" : "Fail"}
              </button>
            ))}
          </div>
          {line ? <span className="text-xs text-[var(--sf-text-2)]">{line}</span> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-[var(--sf-text-2)]">What went wrong?</span>
          <div className="flex flex-wrap gap-1.5">
            {tagChoices.map((tag) => {
              const on = hasTag(state.tags, tag);
              return (
                <button
                  key={tag}
                  type="button"
                  disabled={!enabled}
                  aria-pressed={on}
                  onClick={() => setState(toggleTag(state, tag, enabled))}
                  className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-40 ${
                    on ? "border-[var(--sf-text-1)] text-[var(--sf-text-1)]" : "border-[var(--sf-hairline-strong)] text-[var(--sf-text-2)]"
                  }`}
                >
                  {tag}
                </button>
              );
            })}
            {newTag === null ? (
              <button
                type="button"
                disabled={!enabled}
                onClick={() => setNewTag("")}
                className="rounded-full border border-dashed border-[var(--sf-hairline-strong)] px-2.5 py-1 text-xs text-[var(--sf-text-2)] disabled:opacity-40"
              >
                + New tag
              </button>
            ) : (
              <input
                autoFocus
                aria-label="New tag"
                value={newTag}
                maxLength={60}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setState(addNewTag(state, newTag, enabled));
                    setNewTag(null);
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setNewTag(null);
                  }
                }}
                onBlur={() => {
                  setState(addNewTag(state, newTag, enabled));
                  setNewTag(null);
                }}
                className="h-7 w-40 rounded-full border border-[var(--sf-hairline-strong)] bg-transparent px-2.5 text-xs text-[var(--sf-text-1)]"
              />
            )}
          </div>
          {!enabled ? <span className="text-xs text-[var(--sf-text-3)]">Tags apply to failed results only.</span> : null}
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
          Why (a sentence is enough)
          <textarea
            value={state.note}
            maxLength={NOTE_MAX}
            rows={2}
            onChange={(e) => setState(setNote(state, e.target.value))}
            className="rounded-lg border border-[var(--sf-hairline-strong)] bg-transparent px-3 py-2 text-[13px] text-[var(--sf-text-1)]"
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--sf-text-3)]">
            {error ? <span className="text-[var(--sf-fail)]">{error}</span> : savedAt && !canSave(state) ? "Saved" : "Failed results with tags feed the Failure types card"}
          </span>
          <button
            type="button"
            disabled={!canSave(state) || busy}
            onClick={() => void save()}
            className="h-8 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)] disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save review"}
          </button>
        </div>
      </div>
    </section>
  );
}

export function CaseDrawer({
  run,
  caseId,
  repeat,
  drawerTab: _drawerTab,
  caseIds,
  flaky,
  vocabulary,
  projectRoot,
  onVocabularyChanged,
  onClose,
  onOpenCase,
  onRepeat,
  onReviewSaved,
  onSuggestionChanged,
}: {
  run: EvalRunDetail;
  caseId: string;
  repeat: number | undefined;
  /** `?tab=transcript` opens the transcript; agent runs open it by default. */
  drawerTab?: "transcript" | undefined;
  caseIds: string[];
  flaky: boolean;
  vocabulary: string[];
  projectRoot?: string;
  onVocabularyChanged: () => void;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
  onRepeat: (index: number) => void;
  onReviewSaved: () => void;
  onSuggestionChanged?: () => void;
}) {
  const { data, error, loading, reload } = useCaseResults(run.eval_run_id, caseId);
  const result = data ? selectRepeat(data.repeats, repeat) : null;
  const agentRun = isAgentRun(run);
  const link = result && agentRun ? sessionLink(result) : null;
  const session = useAgentSession(link?.agentId ?? null, link?.sessionId ?? null);
  const [section, setSection] = useState<"transcript" | "grades">("transcript");
  const stageRunExists = useStageRunExists(agentRun ? null : (result?.stage_run_id ?? null));
  const realTools = usedRealTools(run);
  const [rerun, setRerun] = useState<{ busy: boolean; error: string | null; result: EvalTryResult | null }>({
    busy: false,
    error: null,
    result: null,
  });
  const { previous, next } = caseNeighbours(caseIds, caseId);

  useEffect(() => {
    setRerun({ busy: false, error: null, result: null });
    setSection("transcript");
  }, [caseId, repeat]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function runAgain() {
    setRerun({ busy: true, error: null, result: null });
    try {
      const res = await tryEvalCase({
        eval_id: run.eval_id,
        case_id: caseId,
        ...(projectRoot ? { project_root: projectRoot } : {}),
      });
      setRerun({ busy: false, error: null, result: res });
    } catch (err) {
      setRerun({ busy: false, error: err instanceof Error ? err.message : String(err), result: null });
    }
  }

  const datasetFile = runDatasetPath(run);
  const title = (data?.case as { title?: string } | undefined)?.title?.trim() || caseId;
  const tabs = data ? repeatTabs(data.repeats) : [];
  const errored = result ? isErrored(result) : false;
  const output = result && !errored ? outputView(result) : null;
  const expected = result && !errored ? expectedFindings(result) : null;
  const panel = rerun.result ? rerunPanelView(rerun.result) : null;
  const view = result && agentRun ? transcriptView(result) : null;
  const rerunView = rerun.result && agentRun ? transcriptView(rerun.result.result) : null;
  const errorInfo = result && errored ? errorView(result) : null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="Case detail"
        className="relative flex h-full w-[620px] max-w-full flex-col border-l border-[var(--sf-hairline)] bg-[var(--sf-panel)]"
      >
        <header className="flex shrink-0 flex-col gap-2 px-5 pb-0 pt-4">
          <div className="flex items-center justify-between gap-3 text-xs text-[var(--sf-text-2)]">
            <span>{drawerHeader(run.eval_id, run.run_number, caseIds, caseId)}</span>
            <span className="flex gap-1">
              <button type="button" aria-label="Previous case" disabled={!previous} onClick={() => previous && onOpenCase(previous)} className="rounded-md border border-[var(--sf-hairline-strong)] p-1 disabled:opacity-40">
                <LuChevronLeft className="size-4" aria-hidden />
              </button>
              <button type="button" aria-label="Next case" disabled={!next} onClick={() => next && onOpenCase(next)} className="rounded-md border border-[var(--sf-hairline-strong)] p-1 disabled:opacity-40">
                <LuChevronRight className="size-4" aria-hidden />
              </button>
              <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1">
                <LuX className="size-4" aria-hidden />
              </button>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-[var(--sf-text-1)]">{title}</h2>
            {flaky ? <Chip tone="needs">Flaky</Chip> : null}
          </div>
          <div className="flex gap-5 border-b border-[var(--sf-hairline)]" role="tablist">
            {tabs.map((tab) => {
              const active = result?.repeat_index === tab.index;
              return (
                <button
                  key={tab.index}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onRepeat(tab.index)}
                  className={`flex items-center gap-2 border-b-2 pb-2.5 text-[13px] ${
                    active ? "border-[var(--sf-text-1)] text-[var(--sf-text-1)]" : "border-transparent text-[var(--sf-text-2)]"
                  }`}
                >
                  <span className={`block size-2 rounded-full ${tab.tone === "ok" ? "bg-[var(--sf-ok)]" : "bg-[var(--sf-fail)]"}`} />
                  {tab.label}
                  {tab.scoreText ? <span className={`${MONO_CLASS} text-xs ${TONE_TEXT[tab.tone]}`}>{tab.scoreText}</span> : null}
                </button>
              );
            })}
          </div>
          {agentRun && result ? (
            <div className="flex gap-4 pt-1" role="tablist" aria-label="Case sections">
              {(
                [
                  ["transcript", "Transcript"],
                  ["grades", "Grades and review"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={section === id}
                  onClick={() => setSection(id)}
                  className={`border-b-2 pb-2 text-[13px] ${section === id ? "border-[var(--sf-text-1)] text-[var(--sf-text-1)]" : "border-transparent text-[var(--sf-text-2)]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          {loading ? <p className="text-[13px] text-[var(--sf-text-2)]">Loading case…</p> : null}
          {error ? (
            <p className="text-[13px] text-[var(--sf-fail)]" role="alert">
              {error}{" "}
              <button type="button" className="underline" onClick={reload}>
                Retry
              </button>
            </p>
          ) : null}
          {data && !result ? <p className="text-[13px] text-[var(--sf-text-2)]">No results were recorded for this case.</p> : null}

          {data && result ? (
            <>
              <section className="flex flex-col gap-2">
                <h3 className={LABEL}>Input</h3>
                <div className={`max-h-48 overflow-auto rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-ground)] p-3 text-xs ${MONO_CLASS}`}>
                  {inputLines(data.case.input).map((line) => (
                    <p key={line.key} className="whitespace-pre-wrap break-words">
                      <span className="text-[var(--sf-text-3)]">{line.key}: </span>
                      {line.value}
                    </p>
                  ))}
                </div>
              </section>

              {panel ? (
                <section className="flex flex-col gap-2 rounded-lg border border-[var(--sf-running)] bg-[var(--sf-running-bg)] p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-[var(--sf-text-1)]">{panel.title}</span>
                    <span className={`${MONO_CLASS} text-[var(--sf-text-2)]`}>{panel.metaText}</span>
                  </div>
                  <p className="text-[13px]">
                    <span className={TONE_TEXT[panel.verdictTone]}>{panel.verdict}</span>
                    <span className={`${MONO_CLASS} ml-2 text-[var(--sf-text-2)]`}>{panel.scoreText}</span>
                  </p>
                  {panel.summary ? <p className="text-[13px] text-[var(--sf-text-1)]">{panel.summary}</p> : null}
                  {panel.error ? (
                    <p className="text-[13px] text-[var(--sf-fail)]">
                      <span className={MONO_CLASS}>{panel.error.code}</span> {panel.error.message}
                    </p>
                  ) : (
                    <GradeList rows={panel.grades} />
                  )}
                  {rerunView ? <TranscriptList view={rerunView} /> : null}
                </section>
              ) : null}
              {rerun.error ? (
                <p className="text-[13px] text-[var(--sf-fail)]" role="alert">
                  {rerun.error}
                </p>
              ) : null}

              {agentRun && section === "transcript" ? (
                <TranscriptSection
                  view={view}
                  expected={view ? expectedChecklist((data.case as { expected?: unknown }).expected, view.subject) : null}
                  error={errorInfo ? { label: errorLabel(errorInfo.code), ...errorInfo } : null}
                />
              ) : null}

              {agentRun && section === "grades" && errored ? (
                <p className="text-[13px] text-[var(--sf-text-2)]">The conversation failed, so it was not graded.</p>
              ) : null}
              {agentRun && section === "grades" && !errored ? (
                <section className="flex flex-col gap-2">
                  <h3 className={LABEL}>Grades for repeat {result.repeat_index + 1}</h3>
                  <GradeList rows={gradeRows(result)} />
                </section>
              ) : null}

              {agentRun ? null : errored ? (
                <section className="flex flex-col gap-2">
                  <h3 className={LABEL}>Result</h3>
                  <div className="rounded-lg border border-[var(--sf-fail)] bg-[var(--sf-fail-bg)] p-3 text-[13px]">
                    <p className={`${MONO_CLASS} text-[var(--sf-fail)]`}>{errorView(result).code}</p>
                    <p className="mt-1 text-[var(--sf-text-1)]">{errorView(result).message}</p>
                  </div>
                </section>
              ) : (
                <>
                  <section className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <h3 className={LABEL}>Output · stage envelope</h3>
                      <span className={`${MONO_CLASS} text-xs text-[var(--sf-text-3)]`}>{output?.metaText}</span>
                    </div>
                    <div className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-ground)] p-3 text-[13px]">
                      {output?.summary ? <p className="border-b border-[var(--sf-hairline)] pb-2 text-[var(--sf-text-1)]">{output.summary}</p> : null}
                      <div className={`max-h-64 overflow-auto pt-2 text-xs text-[var(--sf-text-2)] ${MONO_CLASS}`}>
                        {output?.lines.map((l, i) => (
                          <p key={i} className="whitespace-pre-wrap break-words">
                            {l}
                          </p>
                        ))}
                        {output && output.moreCount > 0 ? <p className="text-[var(--sf-text-3)]">… {output.moreCount} more</p> : null}
                      </div>
                    </div>
                  </section>
                  {expected ? (
                    <section className="flex flex-col gap-2">
                      <h3 className={LABEL}>Expected findings</h3>
                      {expected.map((item) => (
                        <div
                          key={item.text}
                          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${
                            item.found ? "bg-[var(--sf-ok-bg)]" : "bg-[var(--sf-fail-bg)]"
                          }`}
                        >
                          {item.found ? <LuCheck className="size-3.5 text-[var(--sf-ok)]" aria-hidden /> : <LuX className="size-3.5 text-[var(--sf-fail)]" aria-hidden />}
                          <span className="text-[var(--sf-text-1)]">{item.text}</span>
                          {!item.found ? <span className={`${MONO_CLASS} text-xs text-[var(--sf-fail)]`}>not in output</span> : null}
                        </div>
                      ))}
                    </section>
                  ) : null}
                  <section className="flex flex-col gap-2">
                    <h3 className={LABEL}>Grades for repeat {result.repeat_index + 1}</h3>
                    <GradeList rows={gradeRows(result)} />
                  </section>
                </>
              )}

              {agentRun && section === "transcript" ? null : (
              <>
              {result.suggestion && !result.passed ? (
                <SuggestionLine
                  evalRunId={run.eval_run_id}
                  suggestion={result.suggestion}
                  onChanged={() => {
                    onVocabularyChanged();
                    onReviewSaved();
                    onSuggestionChanged?.();
                    reload();
                  }}
                />
              ) : null}
              <ReviewCard
                run={run}
                result={result}
                vocabulary={vocabulary}
                onSaved={() => {
                  onVocabularyChanged();
                  onReviewSaved();
                  reload();
                }}
              />
              </>
              )}
            </>
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--sf-hairline)] px-5 py-3">
          {agentRun && link && session.status === "found" ? (
            <button
              type="button"
              onClick={() => navigate(agentRunPath(link.agentId, link.sessionId, session.runId))}
              className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
            >
              <LuExternalLink className="size-3.5" aria-hidden />
              Open agent run
            </button>
          ) : null}
          {agentRun && link && session.status === "deleted" ? <span className="text-xs text-[var(--sf-text-3)]">{SESSION_DELETED}</span> : null}
          {result && result.stage_run_id && stageRunExists ? (
            <button
              type="button"
              onClick={() => navigate(runStreamPath(result.stage_run_id!))}
              className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
            >
              <LuExternalLink className="size-3.5" aria-hidden />
              Open stage run
            </button>
          ) : null}
          <button
            type="button"
            disabled={rerun.busy || realTools}
            title={realTools ? "This eval uses real tools. Run it from the Run dialog to confirm." : undefined}
            onClick={() => void runAgain()}
            className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-50"
          >
            <LuRefreshCw className={`size-3.5 ${rerun.busy ? "animate-spin" : ""}`} aria-hidden />
            {rerun.busy ? "Re-running…" : "Re-run this case"}
          </button>
          <span className="flex-1" />
          {datasetFile ? (
            <button
              type="button"
              onClick={() => navigate(datasetPath(datasetIdOf(datasetFile), { eval: run.eval_id }))}
              className="text-[13px] text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
            >
              Edit case in dataset
            </button>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}
