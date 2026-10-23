import type { ReactNode } from "react";
import { LuSquare } from "react-icons/lu";
import { LEAVE_NOTE, type DotState, type LiveModel, type LiveRowModel } from "./liveProgressModel";

const MONO = "font-['Geist_Mono',monospace]";

const DOT_COLOR: Record<DotState, string> = {
  passed: "var(--sf-ok)",
  failed: "var(--sf-fail)",
  running: "var(--sf-running)",
  queued: "color-mix(in srgb, var(--sf-text-3) 55%, transparent)",
};

const SCORE_COLOR = {
  ok: "var(--sf-ok)",
  needs: "var(--sf-needs)",
  fail: "var(--sf-fail)",
  muted: "var(--sf-text-3)",
} as const;

const LEGEND: Array<{ kind: DotState; label: string }> = [
  { kind: "passed", label: "passed" },
  { kind: "failed", label: "failed" },
  { kind: "running", label: "running" },
  { kind: "queued", label: "queued" },
];

export function StopButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-50"
    >
      <LuSquare className="size-3 text-[var(--sf-fail)]" aria-hidden />
      {busy ? "Stopping…" : "Stop run"}
    </button>
  );
}

function Tile({ label, children, color }: { label: string; children: ReactNode; color?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 border-l border-l-[var(--sf-hairline)] px-5 py-4 first:border-l-0">
      <span className="text-xs text-[var(--sf-text-2)]">{label}</span>
      <span className={`${MONO} truncate text-xl font-semibold`} style={{ color: color ?? "var(--sf-text-1)" }}>
        {children}
      </span>
    </div>
  );
}

function Dots({ dots }: { dots: DotState[] }) {
  return (
    <span className="flex items-center gap-1" aria-label={dots.join(", ")}>
      {dots.map((state, index) => (
        <span key={index} className="block size-2 rounded-full" style={{ background: DOT_COLOR[state] }} />
      ))}
    </span>
  );
}

function Row({ row }: { row: LiveRowModel }) {
  return (
    <div role="row" className="flex items-center gap-4 border-b border-b-[var(--sf-hairline)] px-4 py-2.5 last:border-b-0">
      <span role="cell" className={`${MONO} w-[48px] shrink-0 text-xs text-[var(--sf-text-2)]`}>
        {row.position !== null ? `#${row.position}` : "—"}
      </span>
      <span role="cell" className="min-w-0 flex-1 truncate text-[13px] text-[var(--sf-text-1)]">
        {row.label}
      </span>
      <span role="cell" className="w-[100px] shrink-0">
        <Dots dots={row.dots} />
      </span>
      <span role="cell" className={`${MONO} w-[64px] shrink-0 text-xs`} style={{ color: SCORE_COLOR[row.scoreTone] }}>
        {row.scoreText}
      </span>
      <span
        role="cell"
        className="w-[210px] shrink-0 truncate text-[13px]"
        style={{ color: row.nowTone === "running" ? "var(--sf-running)" : row.nowTone === "fail" ? "var(--sf-fail)" : "var(--sf-text-2)" }}
      >
        {row.nowText}
      </span>
    </div>
  );
}

export function LiveProgress({ model, runNumber }: { model: LiveModel; runNumber: number }) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <section className="shrink-0 overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
          <div className="flex flex-col gap-3 px-5 pb-4 pt-4">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="font-medium text-[var(--sf-text-1)]">{model.headline}</span>
              <span className={`${MONO} text-xs text-[var(--sf-text-2)]`}>{model.percentText}</span>
            </div>
            <div
              className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--sf-track-empty)]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={model.total}
              aria-valuenow={model.counts.passed + model.counts.failed}
            >
              {model.segments.map((segment) => (
                <span
                  key={segment.kind}
                  className="block h-full"
                  style={{ width: `${segment.percent}%`, background: segment.kind === "queued" ? "transparent" : DOT_COLOR[segment.kind] }}
                />
              ))}
            </div>
            <div className="flex items-center gap-4 text-xs text-[var(--sf-text-2)]">
              {LEGEND.map(({ kind, label }) => (
                <span key={kind} className="flex items-center gap-1.5">
                  <span className="block size-1.5 rounded-full" style={{ background: DOT_COLOR[kind] }} />
                  {model.counts[kind]} {label}
                </span>
              ))}
            </div>
          </div>
          <div className="flex border-t border-t-[var(--sf-hairline)]">
            <Tile label="Passing so far" color={model.passingText === "—" ? undefined : "var(--sf-ok)"}>
              {model.passingText}
            </Tile>
            <Tile label="Cost so far of limit">{model.costText}</Tile>
            <Tile label="Elapsed">{model.elapsedText}</Tile>
            <Tile label="Estimated left">{model.leftText}</Tile>
          </div>
        </section>

        <section className="shrink-0 overflow-hidden rounded-lg border border-[var(--sf-hairline)]" role="table" aria-label="Results as they arrive">
          <div className="flex items-center justify-between gap-3 border-b border-b-[var(--sf-hairline)] px-4 py-3">
            <h2 className="text-[13px] font-medium text-[var(--sf-text-1)]">Results as they arrive</h2>
            <span className="text-xs text-[var(--sf-text-3)]">{LEAVE_NOTE}</span>
          </div>
          <div role="row" className="flex items-center gap-4 border-b border-b-[var(--sf-hairline)] px-4 py-2 text-xs text-[var(--sf-text-3)]">
            <span role="columnheader" className="w-[48px] shrink-0">Case</span>
            <span role="columnheader" className="min-w-0 flex-1">Input</span>
            <span role="columnheader" className="w-[100px] shrink-0">Repeats</span>
            <span role="columnheader" className="w-[64px] shrink-0">Score</span>
            <span role="columnheader" className="w-[210px] shrink-0">Now</span>
          </div>
          {model.rows.length === 0 ? (
            <p className="px-4 py-6 text-xs text-[var(--sf-text-3)]">Waiting for the first result…</p>
          ) : (
            model.rows.map((row) => <Row key={row.caseId} row={row} />)
          )}
        </section>
      </div>
      <footer className="flex h-8 w-full shrink-0 items-center justify-between gap-4 border-t border-t-[var(--sf-hairline)] bg-[var(--sf-rail)] px-5 text-xs text-[var(--sf-text-3)]">
        <span className="truncate">{model.footer}</span>
        <span className="shrink-0">Run #{runNumber}</span>
      </footer>
    </>
  );
}
