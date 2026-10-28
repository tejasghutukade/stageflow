import { useCallback, useEffect, useState } from "react";
import { calibrateEvalGrader, fetchEval, fetchEvalCalibrations, suggestEvalExamples, updateEval } from "../../../api";
import type { EvalCalibration, EvalExampleSuggestion } from "../../../api/evalTypes";
import { calibrationBadge, calibrationCurrent, calibrationView } from "./calibrationModel";
import { Chip, MONO_CLASS } from "./ResultsParts";
import { compareLine, exampleLabel, MAX_RUBRIC_EXAMPLES, rubricOf, withExample, withRubric } from "./tuningModel";

type Split = "all" | "dev" | "held_out";

const BUTTON = "text-xs text-[var(--sf-text-1)] underline disabled:opacity-50";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CalibrationPanel({
  evalId,
  graderId,
  graderHash,
  judge,
  onOpenCase,
  onEvalChanged,
}: {
  evalId: string;
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
  const disabled = busy !== null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--sf-hairline)] p-3">
      <div className="flex items-center justify-between gap-3">
        <Chip tone={latest && current ? "ok" : "muted"}>{calibrationBadge(latest, current)}</Chip>
        <span className="flex items-center gap-3">
          <select
            aria-label="Labels to measure"
            className="rounded border border-[var(--sf-hairline)] bg-transparent text-xs"
            value={split}
            onChange={(e) => setSplit(e.target.value as Split)}
          >
            <option value="all">All labels</option>
            <option value="dev">Dev labels (70%)</option>
            <option value="held_out">Held-out labels (30%)</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-[var(--sf-text-3)]" title="Judges each output three times: about 3x the cost">
            <input type="checkbox" checked={stability} onChange={(e) => setStability(e.target.checked)} />
            Stability
          </label>
          <button type="button" disabled={disabled} onClick={() => void check()} className={BUTTON}>
            {busy === "check" ? "Judging your labels…" : "Check judge against my labels"}
          </button>
        </span>
      </div>
      {!latest ? (
        <p className="text-xs text-[var(--sf-text-3)]">
          Mark Pass or Fail on this grader in a case drawer. The judge then re-reads those outputs (no stage runs) and
          the agreement is shown here. It calls the judge model once per label.
        </p>
      ) : null}
      {error ? <p className="text-xs text-[var(--sf-fail)]">{error}</p> : null}
      {note ? <p className="text-xs text-[var(--sf-text-2)]">{note}</p> : null}
      {view ? (
        <>
          <p className={`${MONO_CLASS} text-xs text-[var(--sf-text-2)]`}>{view.headline}</p>
          {view.rows.map((r) => (
            <p key={r.label} className="flex justify-between gap-3 text-xs text-[var(--sf-text-3)]">
              <span>{r.label}</span>
              <span className={MONO_CLASS}>{r.value}</span>
            </p>
          ))}
          {view.warnings.map((w) => (
            <p key={w} className="text-xs text-[var(--sf-needs)]">
              {w}
            </p>
          ))}
          {view.disagreements.length > 0 ? (
            <div>
              <p className="mb-1 text-xs text-[var(--sf-text-3)]">Where the judge disagrees with you</p>
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
          <div className="flex items-center gap-4 border-t border-[var(--sf-hairline)] pt-2">
            <button type="button" disabled={disabled} onClick={() => void suggest()} className={BUTTON}>
              {busy === "suggest" ? "Looking…" : "Suggest examples from disagreements"}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => (tuning ? setTuning(false) : void openTuning())}
              className={BUTTON}
            >
              {tuning ? "Close rubric trial" : "Try a different rubric"}
            </button>
          </div>
        </>
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
    </div>
  );
}
