import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuArrowLeft, LuArrowRight, LuCheck, LuEye, LuEyeOff, LuX } from "react-icons/lu";
import { fetchEval, fetchEvalLabelQueue, putEvalGraderLabel } from "../../../api";
import type { EvalLabelQueue, EvalLabelQueueItem } from "../../../api/evalTypes";
import { outputView } from "./drawerModel";
import {
  ORDER_LABELS,
  agreementText,
  countLabels,
  entryOf,
  keyAction,
  keyOf,
  labelAdvice,
  orderQueue,
  readHideJudge,
  wantedText,
  writeHideJudge,
  type QueueEntry,
  type QueueOrder,
} from "./labelQueueModel";
import { MONO_CLASS } from "./ResultsParts";
import { TranscriptList } from "./TranscriptView";
import { transcriptView } from "./transcriptModel";
import { rubricOf } from "./tuningModel";

const AUTO_ADVANCE_MS = 900;
const SECTION = "text-[11px] font-medium uppercase tracking-wide text-[var(--sf-text-3)]";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ResultBody({ item }: { item: EvalLabelQueueItem }) {
  const transcript = transcriptView(item.result);
  if (transcript) return <TranscriptList view={transcript} />;
  const output = outputView(item.result);
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      {output.summary ? <p className="text-[var(--sf-text-1)]">{output.summary}</p> : null}
      {output.lines.length > 0 ? (
        <pre className={`${MONO_CLASS} max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--sf-raised)] p-3 text-xs text-[var(--sf-text-2)]`}>
          {output.lines.join("\n")}
        </pre>
      ) : null}
      {output.moreCount > 0 ? <p className="text-xs text-[var(--sf-text-3)]">…and {output.moreCount} more lines</p> : null}
    </div>
  );
}

function JudgeBox({
  item,
  shown,
  onShow,
}: {
  item: EvalLabelQueueItem;
  shown: boolean;
  onShow: () => void;
}) {
  if (!shown) {
    return (
      <button
        type="button"
        onClick={onShow}
        className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--sf-hairline-strong)] px-3 py-2 text-left text-[13px] text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
      >
        <LuEye className="size-3.5" aria-hidden />
        Show the judge&apos;s answer <kbd className={`${MONO_CLASS} ml-auto text-[11px] text-[var(--sf-text-3)]`}>J</kbd>
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-ground)] p-3 text-[13px]">
      <p className="flex items-center gap-2">
        {item.judge.passed ? <LuCheck className="size-3.5 text-[var(--sf-ok)]" aria-hidden /> : <LuX className="size-3.5 text-[var(--sf-fail)]" aria-hidden />}
        <span className="text-[var(--sf-text-1)]">Judge said {item.judge.passed ? "Pass" : "Fail"}</span>
      </p>
      {item.judge.reason ? <p className="text-xs text-[var(--sf-text-2)]">{item.judge.reason}</p> : null}
    </div>
  );
}

export function LabelQueue({
  evalId,
  evalRunId,
  graderId,
  startKey,
  onClose,
}: {
  evalId: string;
  evalRunId: string;
  graderId: string;
  /** Open at this result (`case#repeat`) with everything in order, instead of at the first unlabeled one. */
  startKey?: string;
  /** Called when the screen closes, so the caller can reread its label counts. */
  onClose: () => void;
}) {
  const [queue, setQueue] = useState<EvalLabelQueue | null>(null);
  const [items, setItems] = useState<EvalLabelQueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rubric, setRubric] = useState("");
  const [order, setOrder] = useState<QueueOrder>("mixed");
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [hideJudge, setHideJudge] = useState(() => readHideJudge(browserStorage()));
  const [revealed, setRevealed] = useState(false);
  const [note, setNote] = useState("");
  const [flash, setFlash] = useState<{ agrees: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<number | null>(null);
  const leftPane = useRef<HTMLDivElement | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    fetchEvalLabelQueue(evalRunId, graderId).then(
      (loaded) => {
        if (cancelled) return;
        setQueue(loaded);
        setItems(loaded.items);
        const start: QueueOrder = startKey ? "all" : loaded.items.some((i) => i.label === null) ? "mixed" : "all";
        const list = orderQueue(loaded.items, start);
        setOrder(start);
        setEntries(list);
        if (startKey) setIndex(Math.max(0, list.findIndex((e) => e.key === startKey)));
      },
      (err) => !cancelled && setError(message(err)),
    );
    fetchEval(evalId).then(
      (detail) => !cancelled && setRubric(rubricOf(detail.definition, graderId)),
      () => undefined,
    );
    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [evalId, evalRunId, graderId]);

  const itemByKey = useMemo(() => new Map(items.map((i) => [entryOf(i).key, i])), [items]);
  const entry = entries[index] ?? null;
  const item = entry ? (itemByKey.get(entry.key) ?? entry.item) : null;

  useEffect(() => {
    setRevealed(false);
    setFlash(null);
    setNote(item?.label?.note ?? "");
    leftPane.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.key]);

  const changeOrder = (next: QueueOrder) => {
    clearTimer();
    setOrder(next);
    setEntries(orderQueue(items, next));
    setIndex(0);
  };

  const go = useCallback(
    (to: number) => {
      clearTimer();
      setIndex(Math.max(0, Math.min(entries.length, to)));
    },
    [entries.length],
  );

  const choose = useCallback(
    async (label: "pass" | "fail") => {
      if (!item || saving) return;
      clearTimer();
      const clearing = item.label?.label === label;
      setSaving(true);
      setError(null);
      try {
        const saved = await putEvalGraderLabel(evalRunId, item.case.id, item.result.repeat_index, graderId, {
          label: clearing ? null : label,
          note: clearing ? null : note.trim() === "" ? null : note.trim(),
        });
        const stored = saved.label === null ? null : { label: saved.label, note: saved.note };
        setItems((list) =>
          list.map((x) => (keyOf(x.case.id, x.result.repeat_index) === keyOf(item.case.id, item.result.repeat_index) ? { ...x, label: stored } : x)),
        );
        if (clearing) {
          setFlash(null);
          return;
        }
        const result = agreementText(item, label);
        setFlash(result);
        setRevealed(true);
        if (result.agrees) timer.current = window.setTimeout(() => go(index + 1), AUTO_ADVANCE_MS);
      } catch (err) {
        setError(message(err));
      } finally {
        setSaving(false);
      }
    },
    [item, saving, evalRunId, graderId, note, go, index],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const action = keyAction(event.key);
      if (action === null) return;
      event.preventDefault();
      if (action === "close") onClose();
      else if (action === "pass" || action === "fail") void choose(action);
      else if (action === "skip" || action === "next") go(index + 1);
      else if (action === "back") go(index - 1);
      else if (action === "judge") setRevealed((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose, go, index, onClose]);

  const toggleHide = (hide: boolean) => {
    setHideJudge(hide);
    writeHideJudge(browserStorage(), hide);
  };

  const mine = countLabels(items);
  const others = queue
    ? { pass: queue.labeled_eval.pass - queue.labeled_here.pass, fail: queue.labeled_eval.fail - queue.labeled_here.fail }
    : { pass: 0, fail: 0 };
  const totals = { pass: Math.max(0, others.pass) + mine.pass, fail: Math.max(0, others.fail) + mine.fail };
  const advice = labelAdvice(totals);
  const finished = queue !== null && entries.length > 0 && index >= entries.length;
  const emptyQueue = queue !== null && entries.length === 0;
  const judgeShown = !hideJudge || revealed || (item?.label ?? null) !== null;
  const wanted = item ? wantedText(item) : null;

  return (
    <div role="dialog" aria-modal="true" aria-label={`Label results for ${graderId}`} className="fixed inset-0 z-50 flex flex-col bg-[var(--sf-ground)]">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--sf-hairline)] px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] px-2.5 py-1 text-[13px] text-[var(--sf-text-1)] hover:bg-[var(--sf-raised)]"
        >
          <LuArrowLeft className="size-3.5" aria-hidden /> Done
        </button>
        <div className="flex flex-col">
          <h2 className="text-[15px] font-medium text-[var(--sf-text-1)]">
            Label results · <span className={MONO_CLASS}>{graderId}</span>
          </h2>
          <p className="text-xs text-[var(--sf-text-3)]">Say whether each answer is a Pass or a Fail. Your labels are what the judge is checked against.</p>
        </div>
        <div className="ml-auto flex min-w-[260px] flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-[var(--sf-text-1)]">
              {advice.total} labeled · {totals.pass} Pass · {totals.fail} Fail
            </span>
            <span className={advice.ready ? "text-[var(--sf-ok)]" : "text-[var(--sf-text-3)]"}>{advice.text}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--sf-raised)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(advice.fraction * 100)}>
            <div className={`h-full rounded-full ${advice.ready ? "bg-[var(--sf-ok)]" : "bg-[var(--sf-running)]"}`} style={{ width: `${Math.round(advice.fraction * 100)}%` }} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--sf-text-2)]">
          Show
          <select
            aria-label="Which results to show"
            value={order}
            onChange={(e) => changeOrder(e.target.value as QueueOrder)}
            className="h-8 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2 text-[13px] text-[var(--sf-text-1)]"
          >
            {(Object.keys(ORDER_LABELS) as QueueOrder[]).map((o) => (
              <option key={o} value={o}>
                {ORDER_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error ? (
        <p role="alert" className="border-b border-[var(--sf-fail)] bg-[var(--sf-fail-bg)] px-5 py-2 text-[13px] text-[var(--sf-fail)]">
          {error}
        </p>
      ) : null}

      {queue === null && !error ? <p className="px-5 py-6 text-[13px] text-[var(--sf-text-3)]">Loading results…</p> : null}
      {emptyQueue ? (
        <div className="flex flex-col items-start gap-3 px-5 py-6 text-[13px] text-[var(--sf-text-2)]">
          <p>{order === "all" ? "The judge has no graded results here." : "Every result is already labeled."}</p>
          {order !== "all" ? (
            <button type="button" onClick={() => changeOrder("all")} className="rounded-lg border border-[var(--sf-hairline-strong)] px-3 py-1.5 text-[var(--sf-text-1)]">
              Show everything
            </button>
          ) : null}
        </div>
      ) : null}

      {finished ? (
        <div className="flex flex-col items-start gap-3 px-5 py-8 text-[13px]">
          <h3 className="text-[15px] font-medium text-[var(--sf-text-1)]">That is the end of the list</h3>
          <p className="text-[var(--sf-text-2)]">
            {advice.total} labeled ({totals.pass} Pass, {totals.fail} Fail). {advice.text}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg bg-[var(--sf-text-1)] px-3 py-1.5 text-[var(--sf-ground)]">
              Done
            </button>
            <button type="button" onClick={() => go(0)} className="rounded-lg border border-[var(--sf-hairline-strong)] px-3 py-1.5 text-[var(--sf-text-1)]">
              Go back to the first
            </button>
          </div>
        </div>
      ) : null}

      {item && !finished ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div ref={leftPane} className="flex min-h-0 flex-col gap-5 overflow-auto px-5 py-5">
            <div className="flex flex-col gap-1">
              <p className="text-xs text-[var(--sf-text-3)]">
                Result {index + 1} of {entries.length} · <span className={MONO_CLASS}>{item.case.id}</span>
                {item.result.repeat_index > 0 ? ` · repeat ${item.result.repeat_index + 1}` : ""}
              </p>
              <h3 className="text-[16px] font-medium text-[var(--sf-text-1)]">{item.case.title ?? item.case.id}</h3>
            </div>
            {wanted ? (
              <section className="flex flex-col gap-1 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] p-3" aria-label="What this case wants">
                <h4 className={SECTION}>What this case wants</h4>
                <p className="text-[13px] text-[var(--sf-text-1)]">{wanted}</p>
              </section>
            ) : null}
            <section className="flex flex-col gap-2" aria-label="The conversation">
              <h4 className={SECTION}>What happened</h4>
              <ResultBody item={item} />
            </section>
          </div>

          <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-t border-[var(--sf-hairline)] px-5 py-5 lg:border-l lg:border-t-0" aria-label="Your decision">
            <div className="flex flex-col gap-1">
              <h4 className={SECTION}>What you are deciding</h4>
              {rubric ? (
                <details className="text-[13px] text-[var(--sf-text-2)]" open>
                  <summary className="cursor-pointer text-[var(--sf-text-3)]">The rule for {graderId}</summary>
                  <p className="mt-1 whitespace-pre-wrap">{rubric}</p>
                </details>
              ) : (
                <p className="text-[13px] text-[var(--sf-text-2)]">Did the agent do what this case wants?</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <h4 className={SECTION}>Your verdict</h4>
              <div className="grid grid-cols-2 gap-2">
                {(["pass", "fail"] as const).map((label) => {
                  const chosen = item.label?.label === label;
                  const tone = chosen
                    ? label === "pass"
                      ? "border-[var(--sf-ok)] bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]"
                      : "border-[var(--sf-fail)] bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]"
                    : "border-[var(--sf-hairline-strong)] text-[var(--sf-text-1)] hover:bg-[var(--sf-raised)]";
                  return (
                    <button
                      key={label}
                      type="button"
                      disabled={saving}
                      aria-pressed={chosen}
                      onClick={() => void choose(label)}
                      className={`flex h-14 flex-col items-center justify-center rounded-xl border text-[15px] font-medium disabled:opacity-60 ${tone}`}
                    >
                      {label === "pass" ? "Pass" : "Fail"}
                      <kbd className={`${MONO_CLASS} text-[10px] font-normal text-[var(--sf-text-3)]`}>{label === "pass" ? "P" : "F"}</kbd>
                    </button>
                  );
                })}
              </div>
              <label className="flex flex-col gap-1 text-xs text-[var(--sf-text-3)]">
                Why? (optional, a few words)
                <textarea
                  rows={2}
                  value={note}
                  maxLength={300}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="This becomes the reason when you teach the judge with examples."
                  className="rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2 py-1.5 text-[13px] text-[var(--sf-text-1)]"
                />
              </label>
              <p className="text-xs text-[var(--sf-text-3)]">Press the same button again to clear a label. Not sure? Skip with S.</p>
            </div>

            {flash ? (
              <p
                role="status"
                className={`rounded-lg px-3 py-2 text-[13px] ${flash.agrees ? "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]" : "bg-[var(--sf-needs-bg)] text-[var(--sf-needs)]"}`}
              >
                Saved. {flash.text}
                {flash.agrees ? "" : " Read why below, then go on."}
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              <JudgeBox item={item} shown={judgeShown} onShow={() => setRevealed(true)} />
              <label className="flex items-center gap-2 text-xs text-[var(--sf-text-3)]">
                <input type="checkbox" checked={hideJudge} onChange={(e) => toggleHide(e.target.checked)} />
                <LuEyeOff className="size-3" aria-hidden /> Hide the judge&apos;s answer until I decide
              </label>
            </div>

            <div className="mt-auto flex items-center justify-between gap-2 pt-2">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => go(index - 1)}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] px-3 py-1.5 text-[13px] text-[var(--sf-text-1)] disabled:opacity-40"
              >
                <LuArrowLeft className="size-3.5" aria-hidden /> Back
              </button>
              <button
                type="button"
                onClick={() => go(index + 1)}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] px-3 py-1.5 text-[13px] text-[var(--sf-text-1)]"
              >
                {item.label ? "Next" : "Skip"} <LuArrowRight className="size-3.5" aria-hidden />
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
