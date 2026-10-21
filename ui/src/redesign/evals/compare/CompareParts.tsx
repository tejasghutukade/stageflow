import type { ReactNode } from "react";
import { LuChevronDown, LuTriangleAlert } from "react-icons/lu";
import {
  CASE_TABS,
  type CaseRowModel,
  type CaseTab,
  type GraderRow,
  type KpiTile,
  type PickerOption,
  type StageDiffModel,
  type StripModel,
  type Tone,
} from "./compareModel";

const MONO = "font-['Geist_Mono',monospace]";

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--sf-ok)",
  needs: "var(--sf-needs)",
  fail: "var(--sf-fail)",
  muted: "var(--sf-text-3)",
};

const CARD = "rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)]";

export function RunPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: PickerOption[];
  onChange: (runNumber: number) => void;
}) {
  return (
    <label className="relative flex h-10 min-w-[160px] flex-col justify-center rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-3">
      <span className="text-[10px] leading-none text-[var(--sf-text-3)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${MONO} w-full cursor-pointer appearance-none bg-transparent pr-5 text-xs text-[var(--sf-text-1)] outline-none`}
      >
        {options.map((o) => (
          <option key={o.runNumber} value={o.runNumber}>
            {o.label}
          </option>
        ))}
      </select>
      <LuChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-[var(--sf-text-2)]" aria-hidden />
    </label>
  );
}

export function StageDiffPanel({
  model,
  expanded,
  onToggle,
}: {
  model: StageDiffModel;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className={CARD} aria-label="What changed in the stage">
      <div className="flex items-center gap-3 border-b border-[var(--sf-hairline)] px-4 py-3">
        <h2 className="text-[13px] font-semibold text-[var(--sf-text-1)]">{model.title}</h2>
        {model.hashes ? <span className={`${MONO} text-xs text-[var(--sf-text-3)]`}>{model.hashes}</span> : null}
        <span className="flex-1" />
        {model.canExpand ? (
          <button type="button" onClick={onToggle} className="text-xs text-[var(--sf-text-1)] hover:underline">
            {expanded ? "Show less" : "View full diff"}
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 p-4">
        {model.lines.length > 0 ? (
          <div className="flex max-h-[420px] flex-col gap-0.5 overflow-auto">
            {model.lines.map((line, index) => (
              <div
                key={index}
                className={`${MONO} flex gap-2 rounded px-2 py-1 text-xs ${
                  line.op === "add"
                    ? "bg-[var(--sf-ok-bg)] text-[var(--sf-text-1)]"
                    : line.op === "remove"
                      ? "bg-[var(--sf-fail-bg)] text-[var(--sf-text-1)]"
                      : "text-[var(--sf-text-3)]"
                }`}
              >
                <span
                  className="w-3 shrink-0"
                  style={{ color: line.op === "add" ? "var(--sf-ok)" : line.op === "remove" ? "var(--sf-fail)" : undefined }}
                >
                  {line.op === "add" ? "+" : line.op === "remove" ? "−" : ""}
                </span>
                <span className="whitespace-pre-wrap break-words">{line.text}</span>
              </div>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-[var(--sf-text-3)]">{model.summary}</p>
      </div>
    </section>
  );
}

export function StageUnchanged() {
  return (
    <section className={`${CARD} px-4 py-3`}>
      <p className="text-xs text-[var(--sf-text-3)]">Stage unchanged</p>
    </section>
  );
}

export function ConstantStrip({ strip }: { strip: StripModel }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-lg border px-4 py-3 ${MONO} text-xs`}
        style={{
          borderColor: strip.amber ? "var(--sf-needs-border)" : "var(--sf-hairline)",
          background: strip.amber ? "var(--sf-needs-bg)" : "var(--sf-panel)",
        }}
      >
        <span className="min-w-0 text-[var(--sf-text-2)]">
          <span className="mr-2 font-medium" style={{ color: "var(--sf-ok)" }}>
            Held constant
          </span>
          {strip.held.length > 0 ? strip.held.join(" · ") : "nothing"}
        </span>
        <span className="min-w-0 text-[var(--sf-text-2)]">
          <span className="mr-2 font-medium" style={{ color: "var(--sf-needs)" }}>
            Changed
          </span>
          {strip.changed.length > 0 ? strip.changed.join(" · ") : "nothing"}
        </span>
      </div>
      {strip.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1" role="status">
          {strip.warnings.map((text) => (
            <li key={text} className="flex items-center gap-2 text-xs text-[var(--sf-text-1)]">
              <LuTriangleAlert className="size-3.5 shrink-0 text-[var(--sf-needs)]" aria-hidden />
              {text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function KpiStrip({ tiles }: { tiles: KpiTile[] }) {
  return (
    <div className={`${CARD} flex flex-wrap`}>
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="flex min-w-[180px] flex-1 flex-col gap-1.5 border-l border-l-[var(--sf-hairline)] px-5 py-4 first:border-l-0"
        >
          <span className="text-xs text-[var(--sf-text-2)]">{tile.label}</span>
          <span className={`${MONO} text-xl font-semibold text-[var(--sf-text-1)]`}>{tile.value}</span>
          <span className={`${MONO} text-xs`} style={{ color: TONE_COLOR[tile.subTone] }}>
            {tile.sub}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ByGrader({ rows }: { rows: GraderRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className={CARD} aria-label="By grader">
      <h2 className="border-b border-[var(--sf-hairline)] px-4 py-3 text-[13px] font-semibold text-[var(--sf-text-1)]">
        By grader
      </h2>
      <ul>
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center gap-4 border-b border-[var(--sf-hairline)] px-4 py-2.5 last:border-b-0"
          >
            <span className={`${MONO} min-w-0 flex-1 truncate text-xs text-[var(--sf-text-1)]`}>{row.id}</span>
            <span className={`${MONO} w-16 text-right text-xs text-[var(--sf-text-2)]`}>{row.aText}</span>
            <span className={`${MONO} w-16 text-xs text-[var(--sf-text-1)]`}>{row.bText}</span>
            <span
              className="relative h-1.5 w-[260px] shrink-0 rounded-full bg-[var(--sf-hairline)]"
              role="img"
              aria-label={row.deltaText}
            >
              <span className="absolute left-1/2 top-[-2px] h-2.5 w-px bg-[var(--sf-hairline-strong)]" />
              {row.bar ? (
                <span
                  className="absolute top-0 h-full rounded-full"
                  style={{
                    background: TONE_COLOR[row.tone],
                    width: `${row.bar.widthPercent}%`,
                    ...(row.bar.side === "right" ? { left: "50%" } : { right: "50%" }),
                  }}
                />
              ) : null}
            </span>
            <span className={`${MONO} w-20 text-xs`} style={{ color: TONE_COLOR[row.tone] }}>
              {row.deltaText}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Dots({ passes }: { passes: boolean[] }) {
  return (
    <span className="flex items-center gap-1" aria-label={passes.map((p) => (p ? "passed" : "failed")).join(", ")}>
      {passes.map((passed, i) => (
        <span key={i} className="block size-2 rounded-full" style={{ background: passed ? "var(--sf-ok)" : "var(--sf-fail)" }} />
      ))}
    </span>
  );
}

export function CasesChanged({
  counts,
  tab,
  onTab,
  rows,
  onOpen,
}: {
  counts: Record<CaseTab, number>;
  tab: CaseTab;
  onTab: (tab: CaseTab) => void;
  rows: CaseRowModel[];
  onOpen: (caseId: string) => void;
}) {
  const tabColor: Record<CaseTab, string> = { fixed: "var(--sf-ok)", regressed: "var(--sf-fail)", unchanged: "var(--sf-text-2)" };
  return (
    <section className={CARD} aria-label="Cases that changed">
      <div className="flex items-center gap-3 border-b border-[var(--sf-hairline)] px-4 py-3">
        <h2 className="mr-2 text-[13px] font-semibold text-[var(--sf-text-1)]">Cases that changed</h2>
        <div role="tablist" className="flex items-center gap-1">
          {CASE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => onTab(t.key)}
              className="rounded-md border px-2.5 py-1 text-xs"
              style={{
                color: tabColor[t.key],
                borderColor: tab === t.key ? `color-mix(in srgb, ${tabColor[t.key]} 40%, transparent)` : "transparent",
                background: tab === t.key ? `color-mix(in srgb, ${tabColor[t.key]} 12%, transparent)` : "transparent",
              }}
            >
              {t.label} {counts[t.key]}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs text-[var(--sf-text-3)]">No cases in this group.</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.caseId} className="border-b border-[var(--sf-hairline)] last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(row.caseId)}
                className="flex w-full items-center gap-4 px-4 py-2.5 text-left hover:bg-[var(--sf-raised)]"
              >
                <span className={`${MONO} w-10 shrink-0 text-xs text-[var(--sf-text-3)]`}>
                  {row.position === null ? "" : `#${row.position}`}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--sf-text-1)]">{row.title}</span>
                <Dots passes={row.before} />
                <span className="text-xs text-[var(--sf-text-3)]" aria-hidden>
                  →
                </span>
                <Dots passes={row.after} />
                <span className={`${MONO} w-14 text-right text-xs`} style={{ color: TONE_COLOR[row.scoreTone] }}>
                  {row.scoreText}
                </span>
                <span className={`${MONO} w-[260px] shrink-0 truncate text-xs text-[var(--sf-text-2)]`}>
                  {row.gradersChanged.join(", ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CompareFooter({ note, chip, amber }: { note: string; chip: string; amber: boolean }) {
  return (
    <footer className="flex flex-wrap items-start justify-between gap-4 border-t border-[var(--sf-hairline)] px-5 py-3">
      <p className="max-w-[820px] text-xs text-[var(--sf-text-2)]">{note}</p>
      <span className="text-xs" style={{ color: amber ? "var(--sf-needs)" : "var(--sf-text-2)" }}>
        {chip}
      </span>
    </footer>
  );
}

export function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return (
    <p className="px-5 py-4 text-[13px]" style={{ color: tone === "fail" ? "var(--sf-fail)" : "var(--sf-text-2)" }} role={tone === "fail" ? "alert" : undefined}>
      {children}
    </p>
  );
}
