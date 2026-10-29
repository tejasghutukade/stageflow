import { useEffect, useMemo, useState } from "react";
import { fetchEval, suggestEvalExamples } from "../../../api";
import type { EvalDefinition, EvalExampleSuggestion } from "../../../api/evalTypes";
import { BTN, BTN_PRIMARY, DialogShell, INPUT, LABEL, MONO } from "../datasets/DialogShell";
import { editEvalDefinition } from "./evalEdit";
import { MAX_RUBRIC_EXAMPLES, exampleCount, exampleKind, exampleSlots, withExamples, withReason } from "./tuningModel";

const EXCERPT_CHARS = 420;

const keyOf = (s: EvalExampleSuggestion): string => `${s.eval_run_id}#${s.case_id}#${s.repeat_index}`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Suggestion({
  item,
  chosen,
  blocked,
  reason,
  onToggle,
  onReason,
}: {
  item: EvalExampleSuggestion;
  chosen: boolean;
  blocked: boolean;
  reason: string;
  onToggle: () => void;
  onReason: (text: string) => void;
}) {
  const [all, setAll] = useState(false);
  const kind = exampleKind(item);
  const text = item.example.output;
  const long = text.length > EXCERPT_CHARS;
  return (
    <li className={`flex flex-col gap-2 rounded-xl border p-3 ${chosen ? "border-[var(--sf-text-2)]" : "border-[var(--sf-hairline)]"}`}>
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={chosen} disabled={blocked && !chosen} onChange={onToggle} aria-label={`Use ${item.case_id} as an example`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{kind.title}</span>
          <span className="text-xs text-[var(--sf-text-3)]">
            {kind.hint} <span className={MONO}>{item.case_id}</span>
            {item.repeat_index > 0 ? ` · repeat ${item.repeat_index + 1}` : ""}
          </span>
        </span>
      </label>
      <pre className={`${MONO} max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--sf-raised)] p-2.5 text-xs text-[var(--sf-text-2)]`}>
        {all || !long ? text : `${text.slice(0, EXCERPT_CHARS)}…`}
      </pre>
      {long ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="self-start text-xs text-[var(--sf-text-3)] underline">
          {all ? "Show less" : "Show all"}
        </button>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Why the answer is a {item.example.verdict === "pass" || (item.example.score ?? 0) >= 4 ? "Pass" : "Fail"} (the judge learns this)</span>
        <input
          className={INPUT}
          value={reason}
          maxLength={300}
          placeholder="A short reason in your own words"
          onChange={(e) => onReason(e.target.value)}
        />
      </label>
    </li>
  );
}

export function TeachDialog({
  evalId,
  graderId,
  calibrationId,
  onClose,
  onAdded,
  onCheckNow,
}: {
  evalId: string;
  graderId: string;
  calibrationId: string | undefined;
  onClose: () => void;
  /** The eval file changed, so the caller can refresh what depends on it. */
  onAdded: () => void;
  onCheckNow: () => void;
}) {
  const [items, setItems] = useState<EvalExampleSuggestion[] | null>(null);
  const [definition, setDefinition] = useState<EvalDefinition | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"pick" | "saving" | "done">("pick");
  const [added, setAdded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([suggestEvalExamples(evalId, graderId, calibrationId), fetchEval(evalId)]).then(
      ([suggested, detail]) => {
        if (cancelled) return;
        setItems(suggested.items);
        setDefinition(detail.definition);
        setReasons(Object.fromEntries(suggested.items.map((s) => [keyOf(s), s.example.reason ?? ""])));
        setChosen(new Set(suggested.items.slice(0, exampleSlots(detail.definition, graderId)).map(keyOf)));
      },
      (err) => !cancelled && setError(message(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [evalId, graderId, calibrationId]);

  const slots = definition ? exampleSlots(definition, graderId) : MAX_RUBRIC_EXAMPLES;
  const existing = definition ? exampleCount(definition, graderId) : 0;
  const picked = useMemo(() => (items ?? []).filter((s) => chosen.has(keyOf(s))), [items, chosen]);

  const toggle = (key: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < slots) next.add(key);
      return next;
    });

  async function add() {
    setPhase("saving");
    setError(null);
    try {
      const examples = picked.map((s) => withReason(s.example, reasons[keyOf(s)] ?? ""));
      const outcome = await editEvalDefinition(evalId, (definition) => withExamples(definition, graderId, examples));
      if (outcome === "unchanged") {
        setError(`This rubric already has ${MAX_RUBRIC_EXAMPLES} examples. Remove one in the eval editor first.`);
        setPhase("pick");
        return;
      }
      setAdded(picked.length);
      setPhase("done");
      onAdded();
    } catch (err) {
      setError(message(err));
      setPhase("pick");
    }
  }

  const empty = items !== null && items.length === 0;
  const subtitle =
    phase === "done"
      ? undefined
      : "These are answers the judge got wrong on your tuning rows. Pick the ones to teach it with. Each becomes a worked example in its rule.";

  return (
    <DialogShell
      title={phase === "done" ? "Examples added" : "Teach the judge with examples"}
      {...(subtitle ? { subtitle } : {})}
      width="w-[680px]"
      onClose={onClose}
      footer={
        phase === "done" ? (
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
            <span className="text-xs text-[var(--sf-text-3)]">
              {items === null
                ? ""
                : `${picked.length} selected · the rubric will have ${existing + picked.length} of ${MAX_RUBRIC_EXAMPLES} examples`}
            </span>
            <span className="flex gap-2">
              <button type="button" className={BTN} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={BTN_PRIMARY} disabled={picked.length === 0 || phase === "saving"} onClick={() => void add()}>
                {phase === "saving" ? "Adding…" : picked.length === 1 ? "Add 1 example" : `Add ${picked.length} examples`}
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
      {phase === "done" ? (
        <p className="text-[13px] text-[var(--sf-text-1)]">
          Added {added} {added === 1 ? "example" : "examples"} to <span className={MONO}>{graderId}</span>. Check the judge again to see whether it helped. For a fair
          reading, measure on the fair-test rows (under Advanced).
        </p>
      ) : items === null && !error ? (
        <p className="text-[13px] text-[var(--sf-text-3)]">Finding answers the judge got wrong…</p>
      ) : empty ? (
        <div className="flex flex-col gap-1 text-[13px] text-[var(--sf-text-2)]">
          <p>Nothing to learn from on your tuning rows.</p>
          <p className="text-xs text-[var(--sf-text-3)]">
            Either the judge agreed with you there, or the disagreements are on the fair-test rows, which are never used for examples so that test stays fair. Label more
            results and check again.
          </p>
        </div>
      ) : (
        <>
          {slots === 0 ? (
            <p className="rounded-lg bg-[var(--sf-needs-bg)] px-3 py-2 text-[13px] text-[var(--sf-needs)]">
              This rubric already has {MAX_RUBRIC_EXAMPLES} examples, the most it can hold.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {(items ?? []).map((item) => {
              const key = keyOf(item);
              return (
                <Suggestion
                  key={key}
                  item={item}
                  chosen={chosen.has(key)}
                  blocked={chosen.size >= slots}
                  reason={reasons[key] ?? ""}
                  onToggle={() => toggle(key)}
                  onReason={(text) => setReasons((r) => ({ ...r, [key]: text }))}
                />
              );
            })}
          </ul>
        </>
      )}
    </DialogShell>
  );
}
