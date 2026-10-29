import { useCallback, useEffect, useState } from "react";
import { calibrateEvalGrader, fetchEvalCalibrations, fetchEvalLabelSummary } from "../../../api";
import type { EvalCalibration, EvalLabelCounts } from "../../../api/evalTypes";
import { calibrationBadge, calibrationCurrent, calibrationView, reliabilityView } from "./calibrationModel";
import { labelAdvice } from "./labelQueueModel";
import { LabelQueue } from "./LabelQueue";
import { Chip, MONO_CLASS, TONE_TEXT } from "./ResultsParts";
import { TeachDialog } from "./TeachDialog";
import { WordingDialog } from "./WordingDialog";

type Split = "all" | "dev" | "held_out";

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
  const [dialog, setDialog] = useState<"teach" | "wording" | null>(null);
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
    });

  const evalChanged = () => {
    void loadLatest();
    onEvalChanged?.();
  };

  const checkNow = () => {
    setDialog(null);
    void check();
  };

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
          <div className="flex flex-wrap items-stretch gap-3">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDialog("teach")}
              className="flex w-[260px] flex-col gap-0.5 rounded-lg border border-[var(--sf-hairline-strong)] p-3 text-left hover:bg-[var(--sf-raised)] disabled:opacity-50"
            >
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Teach it with examples</span>
              <span className="text-xs text-[var(--sf-text-3)]">Pick answers it got wrong and add them as worked examples. You review each one first.</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDialog("wording")}
              className="flex w-[260px] flex-col gap-0.5 rounded-lg border border-[var(--sf-hairline-strong)] p-3 text-left hover:bg-[var(--sf-raised)] disabled:opacity-50"
            >
              <span className="text-[13px] font-medium text-[var(--sf-text-1)]">Try different wording</span>
              <span className="text-xs text-[var(--sf-text-3)]">Edit the rule, test it on your labels, and save it only if it holds up.</span>
            </button>
          </div>
        </section>
      ) : null}
      {dialog === "teach" ? (
        <TeachDialog
          evalId={evalId}
          graderId={graderId}
          calibrationId={latest?.id}
          onClose={() => setDialog(null)}
          onAdded={evalChanged}
          onCheckNow={checkNow}
        />
      ) : null}
      {dialog === "wording" ? (
        <WordingDialog
          evalId={evalId}
          graderId={graderId}
          graderHash={graderHash}
          judge={judge}
          onClose={() => setDialog(null)}
          onSaved={evalChanged}
          onCheckNow={checkNow}
        />
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
