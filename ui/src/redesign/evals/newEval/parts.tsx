import type { ReactNode } from "react";
import { LuCheck, LuCircleAlert, LuCircleDashed } from "react-icons/lu";
import { INPUT } from "../datasets/DialogShell";
import type { CheckLine } from "./wizardModel";
import type { ValidationFinding } from "../../../api/types";

export const MONO = "font-['Geist_Mono',monospace]";
export const SMALL_LABEL = "text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]";
export const SELECT = `${INPUT} appearance-none pr-7`;
export const CARD = "rounded-xl border border-[var(--sf-hairline)] bg-[var(--sf-panel)]";

export function Section({ n, title, hint, right, children }: { n: number; title: string; hint?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={`${CARD} overflow-hidden`}>
      <header className="flex items-center gap-2.5 border-b border-b-[var(--sf-hairline)] px-4 py-3">
        <span className="flex size-5 items-center justify-center rounded-full border border-[var(--sf-hairline-strong)] text-[11px] text-[var(--sf-text-2)]">{n}</span>
        <h2 className="text-[14px] font-semibold text-[var(--sf-text-1)]">{title}</h2>
        {hint ? <span className="text-xs text-[var(--sf-text-3)]">{hint}</span> : null}
        <span className="ml-auto">{right}</span>
      </header>
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, warn, children }: { label: string; hint?: string; error?: string | undefined; warn?: string | undefined; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] text-[var(--sf-text-2)]">
      <span>{label}</span>
      {children}
      {error ? <span role="alert" className="text-xs text-[var(--sf-fail)]">{error}</span> : null}
      {warn ? <span className="text-xs text-[var(--sf-warn,#e5a50a)]">{warn}</span> : null}
      {!error && !warn && hint ? <span className="text-xs text-[var(--sf-text-3)]">{hint}</span> : null}
    </label>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "info" }) {
  const color =
    tone === "warn"
      ? "border-[#e5a50a55] text-[var(--sf-warn,#e5a50a)]"
      : tone === "info"
        ? "border-[#4c8dff55] text-[#7aa7ff]"
        : "border-[var(--sf-hairline-strong)] text-[var(--sf-text-2)]";
  return <span className={`rounded border px-1.5 py-px text-[11px] ${color}`}>{children}</span>;
}

export function CheckList({ lines }: { lines: CheckLine[] }) {
  return (
    <ul className="flex flex-col gap-2 text-[13px]">
      {lines.map((l, i) => {
        const Icon = l.tone === "ok" ? LuCheck : l.tone === "muted" ? LuCircleDashed : LuCircleAlert;
        const color =
          l.tone === "ok" ? "text-[var(--sf-pass,#3ecf8e)]" : l.tone === "error" ? "text-[var(--sf-fail)]" : l.tone === "warning" ? "text-[var(--sf-warn,#e5a50a)]" : "text-[var(--sf-text-3)]";
        return (
          <li key={i} className="flex items-start gap-2 text-[var(--sf-text-2)]">
            <Icon className={`mt-0.5 size-3.5 shrink-0 ${color}`} aria-hidden />
            <span>{l.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function FindingsList({ findings }: { findings: readonly ValidationFinding[] }) {
  if (findings.length === 0) return <p className="text-[13px] text-[var(--sf-text-3)]">No findings.</p>;
  return (
    <ul className="flex flex-col gap-1.5 text-[13px]">
      {findings.map((f, i) => (
        <li key={i} className={`flex gap-2 ${f.severity === "error" ? "text-[var(--sf-fail)]" : "text-[var(--sf-warn,#e5a50a)]"}`}>
          <LuCircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {f.message} <span className={`${MONO} text-[11px] opacity-70`}>{f.code}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function YamlBlock({ title, yaml, loading, badge }: { title?: string; yaml: string; loading?: boolean; badge?: string }) {
  return (
    <div className={`${CARD} overflow-hidden`}>
      {title ? (
        <div className="flex items-center justify-between border-b border-b-[var(--sf-hairline)] px-3.5 py-2.5">
          <span className={`${MONO} text-xs text-[var(--sf-text-1)]`}>{title}</span>
          {badge ? <span className={`${MONO} rounded bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-3)]`}>{loading ? "updating…" : badge}</span> : null}
        </div>
      ) : null}
      <pre className={`${MONO} max-h-[340px] overflow-auto whitespace-pre px-3.5 py-3 text-xs leading-[1.6] text-[var(--sf-text-2)]`}>{yaml || "…"}</pre>
    </div>
  );
}
