import { useEffect, useState } from "react";
import { calibrateEvalGrader, fetchEval, fetchEvalCalibrations, updateEval } from "../../../api";
import type { EvalCalibration } from "../../../api/evalTypes";
import { BTN, BTN_PRIMARY, DialogShell, LABEL, MONO, TEXTAREA } from "../datasets/DialogShell";
import { calibrationCurrent, reliabilityView } from "./calibrationModel";
import { TONE_TEXT } from "./ResultsParts";
import { changeText, rubricOf, withRubric, wordingVerdict, type SplitResult } from "./tuningModel";

type Split = "dev" | "held_out";

const SPLITS: Array<{ id: Split; title: string; what: string }> = [
  { id: "dev", title: "Tuning rows", what: "The labeled answers you write the wording against." },
  { id: "held_out", title: "Fair-test rows", what: "Labeled answers kept aside. A wording only counts as better if it holds up here." },
];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ResultCard({
  title,
  what,
  result,
  busyText,
  canRun,
  blockedText,
  onRun,
}: {
  title: string;
  what: string;
  result: SplitResult | null;
  busyText: string | null;
  canRun: boolean;
  blockedText: string;
  onRun: () => void;
}) {
  const saved = result ? reliabilityView(result.saved) : null;
  const next = result ? reliabilityView(result.candidate) : null;
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-[var(--sf-hairline)] p-3" aria-label={title}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <h4 className="text-[13px] font-medium text-[var(--sf-text-1)]">{title}</h4>
          <p className="text-xs text-[var(--sf-text-3)]">{what}</p>
        </div>
        <button type="button" className={BTN} disabled={!canRun || busyText !== null} onClick={onRun}>
          {busyText ?? (result ? "Test again" : "Test")}
        </button>
      </div>
      {!canRun && !result ? <p className="text-xs text-[var(--sf-text-3)]">{blockedText}</p> : null}
      {result && saved && next ? (
        <div className="flex flex-col gap-1 text-[13px]">
          <p className="text-[var(--sf-text-1)]">
            Agreement with you (kappa): <span className={MONO}>{changeText(result)}</span>
          </p>
          <p className="text-xs text-[var(--sf-text-2)]">
            Saved wording: <span className={TONE_TEXT[saved.tone]}>{saved.title}</span>. {saved.detail}
          </p>
          <p className="text-xs text-[var(--sf-text-2)]">
            Your wording: <span className={TONE_TEXT[next.tone]}>{next.title}</span>. {next.detail}
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function WordingDialog({
  evalId,
  graderId,
  graderHash,
  judge,
  onClose,
  onSaved,
  onCheckNow,
}: {
  evalId: string;
  graderId: string;
  graderHash: string | null;
  judge: string | null;
  onClose: () => void;
  /** The eval file changed, so the caller can refresh what depends on it. */
  onSaved: () => void;
  onCheckNow: () => void;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const [rubric, setRubric] = useState("");
  const [results, setResults] = useState<Record<Split, SplitResult | null>>({ dev: null, held_out: null });
  const [busy, setBusy] = useState<{ split: Split | "save"; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEval(evalId).then(
      (detail) => {
        if (cancelled) return;
        const text = rubricOf(detail.definition, graderId);
        setSaved(text);
        setRubric(text);
      },
      (err) => !cancelled && setError(message(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [evalId, graderId]);

  const changed = saved !== null && rubric.trim() !== saved.trim() && rubric.trim() !== "";

  const edit = (text: string) => {
    setRubric(text);
    setResults({ dev: null, held_out: null });
    setError(null);
  };

  async function test(split: Split) {
    setError(null);
    try {
      setBusy({ split, text: "Checking the saved wording…" });
      const known = (await fetchEvalCalibrations(evalId, graderId)).items.find(
        (c: EvalCalibration) => !c.candidate && c.split === split && calibrationCurrent(c, graderHash, judge),
      );
      const base = known ?? (await calibrateEvalGrader(evalId, graderId, { split }));
      setBusy({ split, text: "Measuring your wording…" });
      const candidate = await calibrateEvalGrader(evalId, graderId, { split, candidate: { rubric } });
      setResults((r) => ({ ...r, [split]: { saved: base, candidate } }));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy({ split: "save", text: "Saving…" });
    setError(null);
    try {
      const detail = await fetchEval(evalId);
      const next = detail.definition ? withRubric(detail.definition, graderId, rubric) : null;
      if (next === null) {
        setError("The saved rubric already has this wording.");
        return;
      }
      await updateEval(evalId, { definition: next, base_hash: detail.file_hash });
      setDone(true);
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const verdict = wordingVerdict(results.dev, results.held_out);
  const step = done ? 4 : results.held_out ? 4 : results.dev ? 3 : changed ? 2 : 1;

  return (
    <DialogShell
      title={done ? "Wording saved" : "Try different wording"}
      {...(done ? {} : { subtitle: "Edit the rule the judge follows, then test it before you save. Nothing changes until you press Save." })}
      width="w-[760px]"
      onClose={onClose}
      footer={
        done ? (
          <>
            <span className="text-xs text-[var(--sf-text-3)]">The judge changed, so its old check is out of date.</span>
            <span className="flex gap-2">
              <button type="button" className={BTN} onClick={onClose}>
                Later
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={onCheckNow}>
                Check the judge now
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="text-xs text-[var(--sf-text-3)]">{changed ? "You have unsaved changes." : "No changes yet."}</span>
            <span className="flex gap-2">
              <button type="button" className={BTN} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={BTN_PRIMARY} disabled={!changed || busy !== null} onClick={() => void save()}>
                {busy?.split === "save" ? "Saving…" : verdict.tone === "ok" ? "Save this wording" : "Save anyway"}
              </button>
            </span>
          </>
        )
      }
    >
      {error ? (
        <p role="alert" className="rounded-lg bg-[var(--sf-fail-bg)] px-3 py-2 text-[13px] text-[var(--sf-fail)]">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="text-[13px] text-[var(--sf-text-1)]">
          The new wording is saved on <span className={MONO}>{graderId}</span>. Check the judge again to see its agreement with you on all your labels.
        </p>
      ) : (
        <>
          <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Steps">
            {["Edit the wording", "Test on tuning rows", "Confirm on fair-test rows", "Save"].map((label, i) => (
              <li key={label} className={step === i + 1 ? "font-medium text-[var(--sf-text-1)]" : step > i + 1 ? "text-[var(--sf-ok)]" : "text-[var(--sf-text-3)]"}>
                {i + 1}. {label}
              </li>
            ))}
          </ol>

          <section className="flex flex-col gap-1.5" aria-label="The wording">
            <div className="flex items-center justify-between gap-3">
              <span className={LABEL}>The rule the judge follows</span>
              {changed ? (
                <button type="button" className="text-xs text-[var(--sf-text-3)] underline" onClick={() => edit(saved ?? "")}>
                  Reset to the saved wording
                </button>
              ) : null}
            </div>
            <textarea
              aria-label="Candidate rubric"
              className={`${TEXTAREA} min-h-[170px]`}
              value={rubric}
              maxLength={4000}
              disabled={saved === null || busy !== null}
              onChange={(e) => edit(e.target.value)}
            />
            <p className="text-xs text-[var(--sf-text-3)]">
              Say what a Pass looks like and what a Fail looks like. Changing the wording clears the test results below.
            </p>
          </section>

          <section className="flex flex-col gap-2" aria-label="Does it help">
            <span className={LABEL}>Does it help?</span>
            {SPLITS.map((split) => (
              <ResultCard
                key={split.id}
                title={split.title}
                what={split.what}
                result={results[split.id]}
                busyText={busy?.split === split.id ? busy.text : null}
                canRun={changed && (split.id === "dev" || results.dev !== null)}
                blockedText={!changed ? "Change the wording first." : "Test on the tuning rows first."}
                onRun={() => void test(split.id)}
              />
            ))}
            <p className="text-xs text-[var(--sf-text-3)]">
              Each test asks the judge about every labeled answer in those rows, a few cents. If the saved wording has no up-to-date check on the same rows, that is
              measured first so the comparison is fair.
            </p>
          </section>

          {results.dev ? (
            <p
              role="status"
              className={`rounded-lg px-3 py-2 text-[13px] ${
                verdict.tone === "ok"
                  ? "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]"
                  : verdict.tone === "fail"
                    ? "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]"
                    : "bg-[var(--sf-needs-bg)] text-[var(--sf-needs)]"
              }`}
            >
              {verdict.text}
            </p>
          ) : null}
        </>
      )}
    </DialogShell>
  );
}
