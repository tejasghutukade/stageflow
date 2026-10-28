import { useCallback, useEffect, useState } from "react";
import { calibrateEvalGrader, fetchEval, fetchEvalCalibrations, fetchEvalLabelSummary, suggestEvalExamples, updateEval } from "../../../api";
import type { EvalCalibration, EvalExampleSuggestion, EvalLabelCounts } from "../../../api/evalTypes";
import { calibrationBadge, calibrationCurrent, calibrationView, reliabilityView } from "./calibrationModel";
import { labelAdvice } from "./labelQueueModel";
import { LabelQueue } from "./LabelQueue";
import { Chip, MONO_CLASS, TONE_TEXT } from "./ResultsParts";
import { compareLine, exampleLabel, MAX_RUBRIC_EXAMPLES, rubricOf, withExample, withRubric } from "./tuningModel";

type Split = "all" | "dev" | "held_out";

const BUTTON = "text-xs text-[var(--sf-text-1)] underline disabled:opacity-50";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CalibrationPanel({
  evalId,
  evalRunId,
  graderId,
  graderHash,
  judge,
  onOpenCase,
  onEvalChanged,
}: {
  evalId: string;
  evalRunId: string;
  graderId: string;
  graderHash: string | null;
  judge: string | null;
  onOpenCase: (caseId: string, repeat: number) => void;
  onEvalChanged?: () => void;
}) {
  const [latest, setLatest] = useState<EvalCalibration | null>(null);
  const [split, setSplit] = useState<Split>("all");
  const [stability, setStability] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);
  const [rubric, setRubric] = useState("");
  const [candidate, setCandidate] = useState<EvalCalibration | null>(null);
  const [suggestions, setSuggestions] = useState<EvalExampleSuggestion[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [labeling, setLabeling] = useState(false);
  const [counts, setCounts] = useState<EvalLabelCounts | null>(null);

  const loadLatest = useCallback(async () => {
    try {
      const page = await fetchEvalCalibrations(evalId, graderId);
      setLatest(page.items[0] ?? null);
    } catch {
      setLatest(null);
    }
  }, [evalId, graderId]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  const loadCounts = useCallback(async () => {
    try {
      setCounts((await fetchEvalLabelSummary(evalRunId, graderId)).labeled_eval);
    } catch {
      setCounts(null);
    }
  }, [evalRunId, graderId]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  async function act<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      return await fn();
    } catch (err) {
      setError(message(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const check = () =>
    act("check", async () => {
      setLatest(await calibrateEvalGrader(evalId, graderId, { split, ...(stability ? { stability: true } : {}) }));
      setCandidate(null);
    });

  const openTuning = () =>
    act("open", async () => {
      const detail = await fetchEval(evalId);
      setRubric(rubricOf(detail.definition, graderId));
      setTuning(true);
    });

  const measure = () =>
    act("measure", async () => {
      setCandidate(await calibrateEvalGrader(evalId, graderId, { split, candidate: { rubric } }));
    });

  const saveRubric = () =>
    act("save", async () => {
      const detail = await fetchEval(evalId);
      const next = detail.definition ? withRubric(detail.definition, graderId, rubric) : null;
      if (next === null) {
        setNote("The saved rubric already has this text.");
        return;
      }
      await updateEval(evalId, { definition: next, base_hash: detail.file_hash });
      setNote("Rubric saved. Check the judge again to measure it.");
      setCandidate(null);
      await loadLatest();
      onEvalChanged?.();
    });

  const suggest = () =>
    act("suggest", async () => {
      const res = await suggestEvalExamples(evalId, graderId, latest?.id);
      setSuggestions(res.items);
      if (res.items.length === 0) setNote("No dev-split disagreements to learn from. Held-out rows are never offered, so the held-out check stays fair.");
    });

  const addExample = (item: EvalExampleSuggestion) =>
    act("add", async () => {
      const detail = await fetchEval(evalId);
      const next = detail.definition ? withExample(detail.definition, graderId, item.example) : null;
      if (next === null) {
        setNote(`A rubric holds at most ${MAX_RUBRIC_EXAMPLES} examples.`);
        return;
      }
      await updateEval(evalId, { definition: next, base_hash: detail.file_hash });
      setSuggestions((list) => (list ?? []).filter((x) => x !== item));
      setNote("Example added to the rubric. Check the judge again to measure it.");
      await loadLatest();
      onEvalChanged?.();
    });

  const current = calibrationCurrent(latest, graderHash, judge);
  const view = latest ? calibrationView(latest) : null;
  const reliability = latest ? reliabilityView(latest) : null;
  const advice = counts ? labelAdvice(counts) : null;
  const disabled = busy !== null;
  const noLabels = counts !== null && advice?.total === 0;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-[var(--sf-hairline)] p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-medium text-[var(--sf-text-1)]">Is this judge reliable?</h4>
        <Chip tone={latest && current ? "ok" : "muted"}>{calibrationBadge(latest, current)}</Chip>
      </div>

      <section className="flex flex-col gap-2" aria-label="Step 1: label results">
        <p className="text-xs font-medium text-[var(--sf-text-1)]">1. Label some results yourself</p>
        <p className="text-xs text-[var(--sf-text-3)]">
          You say Pass or Fail on real answers, one at a time. The judge is then checked against what you said.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setLabeling(true)}
            className="rounded-lg bg-[var(--sf-text-1)] px-3 py-1.5 text-[13px] text-[var(--sf-ground)] disabled:opacity-50"
          >
            {advice && advice.total > 0 ? "Label more results" : "Label results"}
          </button>
          {advice ? (
            <span className="flex min-w-[200px] flex-1 flex-col gap-1">
              <span className="flex justify-between gap-3 text-xs">
                <span className="text-[var(--sf-text-1)]">
                  {advice.total} labeled{counts ? ` (${counts.pass} Pass, ${counts.fail} Fail)` : ""}
                </span>
                <span className={advice.ready ? "text-[var(--sf-ok)]" : "text-[var(--sf-text-3)]"}>{advice.text}</span>
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-[var(--sf-raised)]">
                <span
                  className={`block h-full rounded-full ${advice.ready ? "bg-[var(--sf-ok)]" : "bg-[var(--sf-running)]"}`}
                  style={{ width: `${Math.round(advice.fraction * 100)}%` }}
                />
              </span>
            </span>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-label="Step 2: check the judge">
        <p className="text-xs font-medium text-[var(--sf-text-1)]">2. Check the judge against your labels</p>
        <p className="text-xs text-[var(--sf-text-3)]">
          The judge re-reads the answers you labeled and gives its own verdict. Nothing is re-run, and it costs a few cents.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={disabled || noLabels}
            onClick={() => void check()}
            className="rounded-lg border border-[var(--sf-hairline-strong)] px-3 py-1.5 text-[13px] text-[var(--sf-text-1)] hover:bg-[var(--sf-raised)] disabled:opacity-50"
          >
            {busy === "check" ? "Judging your labels…" : latest ? "Check again" : "Check the judge"}
          </button>
          {noLabels ? <span className="text-xs text-[var(--sf-text-3)]">Label a few results first.</span> : null}
          {advice && advice.total > 0 && !advice.ready ? (
            <span className="text-xs text-[var(--sf-text-3)]">With fewer than 20 labels the reading is rough.</span>
          ) : null}
        </div>
        <details className="text-xs text-[var(--sf-text-3)]">
          <summary className="cursor-pointer">Advanced</summary>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              Measure on
              <select
                aria-label="Labels to measure"
                className="rounded border border-[var(--sf-hairline)] bg-transparent text-xs"
                value={split}
                onChange={(e) => setSplit(e.target.value as Split)}
              >
                <option value="all">All labels</option>
                <option value="dev">Tuning rows (dev, 70%)</option>
                <option value="held_out">Fair-test rows (held-out, 30%)</option>
              </select>
            </label>
            <label className="flex items-center gap-1" title="Judges each output three times: about 3x the cost">
              <input type="checkbox" checked={stability} onChange={(e) => setStability(e.target.checked)} />
              Also test how steady it is (3x the cost)
            </label>
          </div>
        </details>
      </section>

      {error ? <p className="text-xs text-[var(--sf-fail)]">{error}</p> : null}
      {note ? <p className="text-xs text-[var(--sf-text-2)]">{note}</p> : null}

      {view && reliability ? (
        <section className="flex flex-col gap-2 rounded-lg bg-[var(--sf-raised)] p-3" aria-label="Result">
          <p className={`text-[14px] font-medium ${TONE_TEXT[reliability.tone]}`}>{reliability.title}</p>
          <p className="text-xs text-[var(--sf-text-2)]">{reliability.detail}</p>
          {reliability.mistakes ? <p className="text-xs text-[var(--sf-text-2)]">{reliability.mistakes}</p> : null}
          {view.warnings.map((w) => (
            <p key={w} className="text-xs text-[var(--sf-needs)]">
              {w}
            </p>
          ))}
          <details className="text-xs text-[var(--sf-text-3)]">
            <summary className="cursor-pointer">The numbers</summary>
            <div className="mt-1 flex flex-col gap-0.5">
              <p className={MONO_CLASS}>{view.headline}</p>
              {view.rows.map((r) => (
                <p key={r.label} className="flex justify-between gap-3">
                  <span>{r.label}</span>
                  <span className={MONO_CLASS}>{r.value}</span>
                </p>
              ))}
            </div>
          </details>
          {view.disagreements.length > 0 ? (
            <div>
              <p className="mb-1 text-xs text-[var(--sf-text-3)]">Where the judge disagrees with you (click to see the answer)</p>
              {view.disagreements.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => onOpenCase(d.caseId, d.repeatIndex)}
                  className="flex w-full items-baseline gap-3 py-1 text-left hover:text-[var(--sf-text-1)]"
                >
                  <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{d.key}</span>
                  <span className="text-xs text-[var(--sf-fail)]">{d.text}</span>
                  <span className="truncate text-xs text-[var(--sf-text-3)]">{d.reason ?? ""}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {view ? (
        <section className="flex flex-col gap-2" aria-label="Step 3: improve the judge">
          <p className="text-xs font-medium text-[var(--sf-text-1)]">3. Make the judge better (optional)</p>
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
            <div className="flex max-w-[260px] flex-col gap-0.5">
              <button type="button" disabled={disabled} onClick={() => void suggest()} className={`${BUTTON} text-left`}>
                {busy === "suggest" ? "Looking…" : "Teach it with examples"}
              </button>
              <span className="text-xs text-[var(--sf-text-3)]">Turns answers it got wrong into worked examples. Nothing is saved until you add one.</span>
            </div>
            <div className="flex max-w-[260px] flex-col gap-0.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => (tuning ? setTuning(false) : void openTuning())}
                className={`${BUTTON} text-left`}
              >
                {tuning ? "Close rubric trial" : "Try different wording"}
              </button>
              <span className="text-xs text-[var(--sf-text-3)]">Edit the rule and measure it before saving. Confirm on the fair-test rows.</span>
            </div>
          </div>
        </section>
      ) : null}
      {suggestions && suggestions.length > 0 ? (
        <div className="flex flex-col gap-2">
          {suggestions.map((item) => (
            <div key={`${item.eval_run_id}${item.case_id}${item.repeat_index}`} className="rounded border border-[var(--sf-hairline)] p-2">
              <p className="mb-1 text-xs text-[var(--sf-text-2)]">{exampleLabel(item)}</p>
              <pre className={`${MONO_CLASS} max-h-24 overflow-auto whitespace-pre-wrap text-xs text-[var(--sf-text-3)]`}>{item.example.output}</pre>
              {item.example.reason ? <p className="mt-1 text-xs text-[var(--sf-text-2)]">Reason: {item.example.reason}</p> : null}
              <button type="button" disabled={disabled} onClick={() => void addExample(item)} className={`${BUTTON} mt-1`}>
                Add to the rubric's examples
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {tuning ? (
        <div className="flex flex-col gap-2 rounded border border-[var(--sf-hairline)] p-2">
          <textarea
            aria-label="Candidate rubric"
            className="min-h-[88px] w-full rounded border border-[var(--sf-hairline)] bg-transparent p-2 text-xs"
            value={rubric}
            maxLength={4000}
            onChange={(e) => setRubric(e.target.value)}
          />
          <div className="flex items-center gap-4">
            <button type="button" disabled={disabled || rubric.trim() === ""} onClick={() => void measure()} className={BUTTON}>
              {busy === "measure" ? "Measuring…" : "Measure this rubric"}
            </button>
            <button type="button" disabled={disabled || rubric.trim() === ""} onClick={() => void saveRubric()} className={BUTTON}>
              Save rubric to the eval
            </button>
          </div>
          {candidate ? (
            <p className={`${MONO_CLASS} text-xs text-[var(--sf-text-2)]`}>
              {compareLine(latest && latest.split === candidate.split ? latest : null, candidate)}
            </p>
          ) : null}
          <p className="text-xs text-[var(--sf-text-3)]">
            Tune on the dev labels, then confirm on the held-out labels before you trust the gain.
          </p>
        </div>
      ) : null}
      {labeling ? (
        <LabelQueue
          evalId={evalId}
          evalRunId={evalRunId}
          graderId={graderId}
          onClose={() => {
            setLabeling(false);
            void loadCounts();
          }}
        />
      ) : null}
    </div>
  );
}
