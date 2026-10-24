import type { ReactNode } from "react";
import type { DotKind } from "./casesModel";
import type { Tone } from "./headerModel";

const MONO = "font-['Geist_Mono',monospace]";

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[var(--sf-ok)]",
  needs: "text-[var(--sf-needs)]",
  fail: "text-[var(--sf-fail)]",
  muted: "text-[var(--sf-text-2)]",
};

export const TONE_BG: Record<Tone, string> = {
  ok: "bg-[var(--sf-ok)]",
  needs: "bg-[var(--sf-needs)]",
  fail: "bg-[var(--sf-fail)]",
  muted: "bg-[var(--sf-track-empty)]",
};

const CHIP_TONE: Record<Tone | "running", string> = {
  running: "bg-[var(--sf-running-bg)] text-[var(--sf-running)]",
  ok: "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]",
  needs: "bg-[var(--sf-needs-bg)] text-[var(--sf-needs)]",
  fail: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]",
  muted: "bg-[var(--sf-raised)] text-[var(--sf-text-2)]",
};

export function Chip({ tone = "muted", mono, children }: { tone?: Tone | "running"; mono?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${mono ? MONO : ""} ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Card({
  title,
  addon,
  right,
  children,
  className = "",
}: {
  title: string;
  addon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] ${className}`}>
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-[var(--sf-text-1)]">{title}</h2>
          {addon ? <span className={`text-xs text-[var(--sf-text-3)] ${MONO}`}>{addon}</span> : null}
        </div>
        {right ? <div className="text-xs text-[var(--sf-text-3)]">{right}</div> : null}
      </header>
      <div className="border-t border-[var(--sf-hairline)]">{children}</div>
    </section>
  );
}

const DOT: Record<DotKind, string> = {
  passed: "bg-[var(--sf-ok)]",
  failed: "bg-[var(--sf-fail)]",
  muted: "bg-[var(--sf-track-empty)]",
};

export function Dots({ dots }: { dots: DotKind[] }) {
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={dots.join(", ")}>
      {dots.map((kind, i) => (
        <span key={i} className={`block size-2 rounded-full ${DOT[kind]}`} />
      ))}
    </span>
  );
}

export function Bar({ fraction, tone }: { fraction: number; tone: Tone }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-[var(--sf-track-empty)]">
      <span className={`block h-full rounded-full ${TONE_BG[tone]}`} style={{ width: `${Math.round(fraction * 100)}%` }} />
    </span>
  );
}

export function KindChip({ kind }: { kind: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] ${
        kind === "Rubric" ? "bg-[var(--sf-running-bg)] text-[var(--sf-running)]" : "bg-[var(--sf-raised)] text-[var(--sf-text-2)]"
      }`}
    >
      {kind}
    </span>
  );
}

export function ButtonLike({
  children,
  onClick,
  primary,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-medium disabled:opacity-50 ${
        primary
          ? "bg-[var(--sf-text-1)] text-[var(--sf-ground)]"
          : "border border-[var(--sf-hairline-strong)] text-[var(--sf-text-1)]"
      }`}
    >
      {children}
    </button>
  );
}

export const MONO_CLASS = MONO;
