import type { ReactNode } from "react";

export type InspectorProps = {
  title?: string;
  children: ReactNode;
  className?: string;
};

export function Inspector({ title, children, className }: InspectorProps) {
  return (
    <aside
      className={`flex w-96 shrink-0 flex-col border-l border-l-[#ffffff12] bg-[var(--sf-panel)] min-h-0${className ? ` ${className}` : ""}`}
    >
      {title ? (
        <div className="shrink-0 border-b border-b-[#ffffff12] px-4 py-3 text-sm font-semibold text-[var(--sf-text-1)]">
          {title}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </aside>
  );
}
