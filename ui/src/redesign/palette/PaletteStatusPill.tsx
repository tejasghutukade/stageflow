import type { StatusSignal } from "../statusSignal";
import { signalIcon, signalLabel } from "../statusSignal";

const PILL_CLASS: Record<StatusSignal, string> = {
  fail: "bg-[#f2645a1a] text-[var(--sf-fail)]",
  ok: "bg-[#4cc38a1a] text-[var(--sf-ok)]",
  needs: "bg-[#f5b5441f] border border-[#f5b5444d] text-[var(--sf-needs)]",
  running: "bg-[#6ca6ff1a] text-[var(--sf-running)]",
  queued: "bg-[#ffffff12] text-[var(--sf-text-2)]",
  skipped: "bg-[#ffffff12] text-[var(--sf-text-3)]",
};

export type PaletteStatusPillProps = {
  signal: StatusSignal;
  label?: string;
  className?: string;
};

export function PaletteStatusPill({
  signal,
  label,
  className,
}: PaletteStatusPillProps) {
  const text = label ?? signalLabel(signal);
  const Icon = signalIcon(signal);
  return (
    <span
      className={`flex h-[22px] min-w-[92px] w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-[7px] py-0 font-sans text-xs font-medium ${PILL_CLASS[signal]}${className ? ` ${className}` : ""}`}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}
