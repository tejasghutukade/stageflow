import { useEffect, type ReactNode } from "react";
import type { DiffLine } from "../../../api/agents";
import { MONO } from "../agentsTokens";

function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#000000aa] p-6" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div
        className="flex max-h-[min(80vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-b-[var(--sf-hairline)] px-4 py-3">
          <h2 className="text-[15px] font-semibold text-[var(--sf-text-1)]">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md border border-[var(--sf-hairline-strong)] px-2.5 py-1 text-[13px] text-[var(--sf-text-2)]">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-t-[var(--sf-hairline)] px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function YamlDialog({ title, yaml, onClose }: { title: string; yaml: string | null; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <pre className={`${MONO} p-4 text-xs leading-[1.6] text-[var(--sf-text-2)]`}>
        {yaml ?? "The draft has errors. Fix them to see the YAML it will save."}
      </pre>
    </Dialog>
  );
}

export function DiffDialog({
  title,
  lines,
  onClose,
  footer,
}: {
  title: string;
  lines: DiffLine[] | null;
  onClose: () => void;
  footer?: ReactNode;
}) {
  return (
    <Dialog title={title} onClose={onClose} footer={footer}>
      {lines === null ? (
        <p className="p-4 text-[13px] text-[var(--sf-text-3)]">Loading…</p>
      ) : lines.every((line) => line.kind === "same") ? (
        <p className="p-4 text-[13px] text-[var(--sf-text-3)]">No differences.</p>
      ) : (
        <div className={`${MONO} py-2 text-xs leading-[1.7]`}>
          {lines.map((line, index) => (
            <div
              key={index}
              className={`flex gap-3 px-4 ${
                line.kind === "added"
                  ? "bg-[#4cc38a14] text-[var(--sf-text-1)]"
                  : line.kind === "removed"
                    ? "bg-[#f2645a14] text-[var(--sf-text-2)] line-through decoration-[#f2645a80]"
                    : "text-[var(--sf-text-3)]"
              }`}
            >
              <span className="w-3 shrink-0 select-none">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
              <span className="whitespace-pre-wrap break-all">{line.text || " "}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Client-side line diff (LCS), for comparing the unsaved draft with the saved YAML. */
export function diffText(before: string, after: string): DiffLine[] {
  const split = (text: string) => {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  const a = split(before);
  const b = split(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ kind: "same", text: a[i++]!, before: i, after: ++j });
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "removed", text: a[i++]!, before: i });
    else out.push({ kind: "added", text: b[j++]!, after: j });
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]!, before: i });
  while (j < b.length) out.push({ kind: "added", text: b[j++]!, after: j });
  return out;
}
