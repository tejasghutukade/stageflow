import { useState } from "react";
import { LuCheck, LuChevronDown, LuChevronRight, LuX } from "react-icons/lu";
import { MONO_CLASS } from "./ResultsParts";
import {
  TRANSCRIPT_EMPTY,
  type BadgeTone,
  type ChecklistRow,
  type ChipView,
  type OutcomeBadge,
  type TranscriptView as TranscriptModel,
} from "./transcriptModel";

const BADGE_CLASS: Record<BadgeTone, string> = {
  ok: "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]",
  neutral: "bg-[var(--sf-raised)] text-[var(--sf-text-2)]",
  running: "bg-[var(--sf-running-bg)] text-[var(--sf-running)]",
  needs: "bg-[var(--sf-needs-bg)] text-[var(--sf-needs)]",
  fail: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]",
};

export function OutcomeBadgeView({ badge }: { badge: OutcomeBadge }) {
  return (
    <span title={badge.tooltip} className={`rounded px-1.5 py-px text-[11px] ${BADGE_CLASS[badge.tone]}`}>
      {badge.label}
    </span>
  );
}

function ToolChip({ chip }: { chip: ChipView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-ground)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
      >
        {open ? <LuChevronDown className="size-3 text-[var(--sf-text-3)]" aria-hidden /> : <LuChevronRight className="size-3 text-[var(--sf-text-3)]" aria-hidden />}
        <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{chip.name}</span>
        <OutcomeBadgeView badge={chip.badge} />
        <span className="text-[var(--sf-text-3)]">{chip.statusText}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-[var(--sf-hairline)] px-2.5 py-2 text-xs">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Arguments</p>
            <pre className={`${MONO_CLASS} max-h-40 overflow-auto whitespace-pre-wrap break-words text-[var(--sf-text-2)]`}>{chip.argsText}</pre>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Result</p>
            <pre className={`${MONO_CLASS} max-h-40 overflow-auto whitespace-pre-wrap break-words text-[var(--sf-text-2)]`}>{chip.resultText}</pre>
            {chip.resultNote ? <p className="text-[var(--sf-text-3)]">{chip.resultNote}</p> : null}
          </div>
          {chip.subSession ? <p className={`${MONO_CLASS} text-[var(--sf-text-3)]`}>sub-agent session {chip.subSession}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Checklist({ rows }: { rows: ChecklistRow[] }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Expected tools">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--sf-text-3)]">Expected tools</h3>
      {rows.map((row) => (
        <div
          key={`${row.kind}:${row.text}`}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${row.ok ? "bg-[var(--sf-ok-bg)]" : "bg-[var(--sf-fail-bg)]"}`}
        >
          {row.ok ? <LuCheck className="size-3.5 text-[var(--sf-ok)]" aria-hidden /> : <LuX className="size-3.5 text-[var(--sf-fail)]" aria-hidden />}
          <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{row.text}</span>
          <span className="text-xs text-[var(--sf-text-3)]">{row.kind === "forbidden" ? "must not be called" : "must be called"}</span>
          <span className={`${MONO_CLASS} ml-auto text-xs ${row.ok ? "text-[var(--sf-text-3)]" : "text-[var(--sf-fail)]"}`}>{row.note}</span>
        </div>
      ))}
    </section>
  );
}

export function HeaderChips({ view }: { view: TranscriptModel }) {
  const chip = "rounded-md bg-[var(--sf-raised)] px-2 py-0.5 text-xs text-[var(--sf-text-2)]";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-md px-2 py-0.5 text-xs ${view.failed ? "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]" : "bg-[var(--sf-raised)] text-[var(--sf-text-1)]"}`}>{view.chips.stop}</span>
      <span className={chip}>{view.chips.turns}</span>
      <span className={chip}>{view.chips.calls}</span>
      <span className={`${chip} ${MONO_CLASS}`}>{view.chips.time}</span>
      <span className={`${chip} ${MONO_CLASS}`}>{view.chips.cost}</span>
    </div>
  );
}

export function TranscriptSection({
  view,
  expected,
  error,
}: {
  view: TranscriptModel | null;
  expected: ChecklistRow[] | null;
  error: { label: string | null; code: string; message: string } | null;
}) {
  if (!view && !error) return <p className="text-[13px] text-[var(--sf-text-3)]">{TRANSCRIPT_EMPTY}</p>;
  return (
    <div className="flex flex-col gap-4">
      {view ? <HeaderChips view={view} /> : null}
      {error ? (
        <div role="alert" className="rounded-lg border border-[var(--sf-fail)] bg-[var(--sf-fail-bg)] p-3 text-[13px]">
          <p className="text-[var(--sf-fail)]">
            {error.label ? <strong className="mr-2">{error.label}</strong> : null}
            <span className={MONO_CLASS}>{error.code}</span>
          </p>
          <p className="mt-1 text-[var(--sf-text-1)]">{error.message}</p>
          <p className="mt-1 text-xs text-[var(--sf-text-3)]">This is as far as the conversation got. It has no grades.</p>
        </div>
      ) : null}
      {expected ? <Checklist rows={expected} /> : null}
      {view ? <TranscriptList view={view} /> : <p className="text-[13px] text-[var(--sf-text-3)]">{TRANSCRIPT_EMPTY}</p>}
    </div>
  );
}

export function TranscriptList({ view, empty = TRANSCRIPT_EMPTY }: { view: TranscriptModel; empty?: string }) {
  if (view.turns.length === 0) return <p className="text-[13px] text-[var(--sf-text-3)]">{empty}</p>;
  return (
    <div className="flex flex-col gap-3">
      {view.notes.map((note) => (
        <p key={note} className="text-xs text-[var(--sf-text-3)]">{note}</p>
      ))}
      {view.turns.map((turn) => (
        <div key={turn.turn} className="flex flex-col gap-2" data-turn={turn.turn}>
          {turn.bubbles.map((b, i) => (
            <div key={i} className={`flex ${b.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-h-56 max-w-[88%] overflow-auto whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[13px] ${
                  b.role === "user" ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "border border-[var(--sf-hairline)] bg-[var(--sf-ground)] text-[var(--sf-text-1)]"
                }`}
              >
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-[var(--sf-text-3)]">{b.role === "user" ? "User" : "Agent"}</span>
                {b.text}
                {b.note ? <span className="mt-1 block text-xs text-[var(--sf-text-3)]">{b.note}</span> : null}
              </div>
            </div>
          ))}
          {turn.chips.length > 0 ? (
            <div className="flex flex-col gap-1.5 pl-3" aria-label={`Tool calls in turn ${turn.turn}`}>
              {turn.chips.map((c) => (
                <ToolChip key={c.id} chip={c} />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
