import type { ReactNode } from "react";

export type KeycapProps = {
  children: ReactNode;
  className?: string;
  as?: "kbd" | "span";
};

export function Keycap({ children, className, as = "span" }: KeycapProps) {
  const Tag = as;
  const classes = [
    "inline-flex items-center rounded-sm border border-[#ffffff1a] px-[5px] font-['Geist_Mono',monospace] text-[11px] leading-normal text-[var(--sf-text-3)]",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <Tag className={classes}>{children}</Tag>;
}
