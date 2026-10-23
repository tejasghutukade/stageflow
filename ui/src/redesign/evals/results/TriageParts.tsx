import { useState } from "react";
import { LuLoader, LuSparkles } from "react-icons/lu";
import type { BucketChipView } from "./triageModel";
import {
  acceptDoneText,
  sortButtonView,
  sortDoneText,
  sortProgressText,
  suggestedView,
  unavailableView,
} from "./triageModel";
import { Bar, MONO_CLASS } from "./ResultsParts";
import type { Triage } from "./useTriage";

const CHIP_TONE = {
  ok: "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]",
  needs: "bg-[var(--sf-needs-bg)] text-[var(--sf-needs)]",
  fail: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]",
  muted: "bg-[var(--sf-raised)] text-[var(--sf-text-2)]",
} as const;

export function BucketChip({ chip }: { chip: BucketChipView }) {
  return (
    <span
      title={chip.title}
      className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] ${CHIP_TONE[chip.tone]} ${
        chip.low ? "border border-dashed border-[var(--sf-text-3)] italic" : ""
      }`}
    >
      {chip.text}
    </span>
  );
}

const BUTTON =
  "flex h-7 items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] px-2.5 text-xs font-medium text-[var(--sf-text-1)] disabled:cursor-not-allowed disabled:opacity-50";

export function SortFailuresButton({ triage, runActive, failed }: { triage: Triage; runActive: boolean; failed: number }) {
  const view = sortButtonView(triage.status, runActive);
  const sorting = triage.sort.phase === "sorting";
  return (
    <span className="flex items-center gap-2">
      {view.via && !sorting ? <span className="text-xs text-[var(--sf-text-3)]">{view.via}</span> : null}
      <button
        type="button"
        className={BUTTON}
        disabled={!view.enabled || sorting || failed === 0}
        title={view.reason ?? (failed === 0 ? "No failed results to sort." : undefined)}
        aria-describedby={view.reason ? "sort-failures-reason" : undefined}
        onClick={() => void triage.runSort("auto")}
      >
        {sorting ? <LuLoader className="size-3.5 animate-spin" aria-hidden /> : <LuSparkles className="size-3.5" aria-hidden />}
        {sorting ? sortProgressText(failed) : view.label}
      </button>
      {view.reason ? (
        <span id="sort-failures-reason" className="sr-only">
          {view.reason}
        </span>
      ) : null}
    </span>
  );
}

export function SuggestedSection({
  triage,
  failed,
  runActive,
  onFilterType,
  onReview,
}: {
  triage: Triage;
  failed: number;
  runActive: boolean;
  onFilterType: (type: string) => void;
  onReview: () => void;
}) {
  const [acceptNote, setAcceptNote] = useState<string | null>(null);
  const sortView = sortButtonView(triage.status, runActive);
  const { sort, suggestions } = triage;
  const view = suggestions ? suggestedView(suggestions.summary, suggestions.items) : null;
  const unavailable = sort.phase === "unavailable" ? unavailableView(triage.status) : null;

  return (
    <div className="flex flex-col gap-3 border-b border-[var(--sf-hairline)] px-4 py-3" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--sf-text-3)]">Suggested</h3>
        {view && !view.empty ? <span className={`${MONO_CLASS} text-xs text-[var(--sf-text-3)]`}>{view.headline}</span> : null}
      </div>

      {sort.phase === "sorting" ? (
        <p className="flex items-center gap-2 text-[13px] text-[var(--sf-text-2)]">
          <LuLoader className="size-3.5 animate-spin" aria-hidden />
          {sortProgressText(failed)}
        </p>
      ) : null}
      {sort.phase === "done" ? <p className="text-xs text-[var(--sf-text-2)]">{sortDoneText(sort.result)}</p> : null}
      {unavailable ? (
        <div role="alert" className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] p-3 text-[13px]">
          <p className="font-medium text-[var(--sf-text-1)]">No classifier is set up</p>
          <p className="mt-1 text-[var(--sf-text-2)]">{unavailable.text}</p>
          {unavailable.judgeFallback ? (
            <button type="button" className={`${BUTTON} mt-2`} onClick={() => void triage.runSort("judge")}>
              Sort with the judge model
            </button>
          ) : null}
        </div>
      ) : null}
      {sort.phase === "error" ? (
        <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
          {sort.message}
        </p>
      ) : null}
      {triage.suggestionsError ? (
        <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
          Could not load suggestions: {triage.suggestionsError}
        </p>
      ) : null}
      {triage.notice ? (
        <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
          {triage.notice}
        </p>
      ) : null}
      {acceptNote ? <p className="text-xs text-[var(--sf-text-2)]">{acceptNote}</p> : null}

      {!view && !triage.suggestionsError ? <p className="text-[13px] text-[var(--sf-text-2)]">Loading suggestions…</p> : null}

      {view && view.empty && sort.phase !== "sorting" && !unavailable ? (
        <p className="text-[13px] text-[var(--sf-text-2)]">
          {failed === 0
            ? "No failed results to sort."
            : sortView.enabled
              ? "Press Sort failures to get a suggested bucket and failure type for every failed result. Nothing is tagged until you accept."
              : (sortView.reason ?? "")}
        </p>
      ) : null}

      {view && !view.empty ? (
        <>
          <div className="flex flex-col gap-1.5">
            {view.bars.map((bar) => (
              <div key={bar.bucket} className="grid grid-cols-[110px_1fr_32px_minmax(120px,160px)] items-center gap-3 text-[13px]">
                <span className="text-[var(--sf-text-1)]">{bar.label}</span>
                <Bar fraction={bar.fraction} tone={bar.tone} />
                <span className={`${MONO_CLASS} text-right text-[var(--sf-text-1)]`}>{bar.count}</span>
                <span className="truncate text-xs text-[var(--sf-text-3)]">{bar.fix}</span>
              </div>
            ))}
          </div>
          {view.types.length > 0 ? (
            <div className="flex flex-col">
              {view.types.map((row) => (
                <button
                  key={row.type}
                  type="button"
                  onClick={() => onFilterType(row.type)}
                  className="grid grid-cols-[minmax(160px,1fr)_2fr_40px] items-center gap-4 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--sf-active)]"
                >
                  <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{row.type}</span>
                  <Bar fraction={row.fraction} tone="fail" />
                  <span className={`${MONO_CLASS} text-right text-[var(--sf-text-1)]`}>{row.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={!view.acceptAllEnabled || triage.busy}
              onClick={async () => {
                const r = await triage.accept({ min_confidence: 0.7 });
                setAcceptNote(r ? acceptDoneText(r) : null);
              }}
            >
              {view.acceptAllText}
            </button>
            <button type="button" className={BUTTON} disabled={!view.reviewEnabled} onClick={onReview}>
              {view.reviewText}
            </button>
            <span className="text-xs text-[var(--sf-text-3)]">Low confidence (under 70% or unclear) is never bulk accepted.</span>
          </div>
        </>
      ) : null}
    </div>
  );
}
