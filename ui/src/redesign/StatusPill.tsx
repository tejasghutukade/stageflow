import type { StatusSignal } from "./statusSignal";
import { signalIcon, signalLabel } from "./statusSignal";
import { useRedesign } from "./flag";

export type StatusPillProps = {
  signal: StatusSignal;
  label?: string;
  elapsed?: string;
  className?: string;
};

function redesignPillClasses(signal: StatusSignal): string {
  const base = "flex h-6 items-center rounded-full px-2 py-0 gap-[5px]";
  if (signal === "needs") {
    return `${base} border border-[#f5b5444d] bg-[#f5b5441f] text-[var(--sf-needs)]`;
  }
  if (signal === "running") {
    return `${base} bg-[#6ca6ff1f] text-[var(--sf-running)]`;
  }
  if (signal === "ok") {
    return `${base} bg-[#4cc38a1a] text-[#4cc38a]`;
  }
  if (signal === "fail") {
    return `${base} bg-[#f2645a1a] text-[#f2645a]`;
  }
  if (signal === "skipped") {
    return `${base} bg-[var(--sf-raised)] text-[var(--sf-text-3)]`;
  }
  return `${base} bg-[var(--sf-raised)] text-[var(--sf-text-3)]`;
}

function redesignIconClass(signal: StatusSignal): string {
  if (signal === "needs") return "size-3 shrink-0 text-[#f5b544]";
  if (signal === "running") return "size-3 shrink-0 text-[var(--sf-running)]";
  if (signal === "ok") return "size-3 shrink-0 text-[#4cc38a]";
  if (signal === "fail") return "size-3 shrink-0 text-[#f2645a]";
  return "size-3 shrink-0";
}

export function StatusPill({
  signal,
  label,
  elapsed,
  className,
}: StatusPillProps) {
  const redesign = useRedesign();
  const text = label ?? signalLabel(signal);
  const Icon = signalIcon(signal);

  if (redesign) {
    return (
      <span
        className={`${redesignPillClasses(signal)}${className ? ` ${className}` : ""}`}
        aria-label={text}
      >
        <Icon className={redesignIconClass(signal)} aria-hidden="true" />
        <span className="font-sans text-xs font-medium leading-normal">{text}</span>
        {elapsed ? (
          <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            {elapsed}
          </span>
        ) : null}
      </span>
    );
  }

  const classes = ["sf-pill", `sf-pill--${signal}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} aria-label={text}>
      <Icon className="sf-pill__icon" aria-hidden="true" />
      <span className="sf-pill__label">{text}</span>
      {elapsed ? <span className="sf-pill__elapsed sf-mono">{elapsed}</span> : null}
    </span>
  );
}
