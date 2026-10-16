import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { DiffLine } from "../../../api/agents";
import { MONO } from "../agentsTokens";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, narrow }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; narrow?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose every render; the Escape listener should not re-subscribe for it.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Move focus in on open and give it back to whatever opened the dialog on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Keep Tab inside the dialog.
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#000000aa] p-6" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div
        ref={panel}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={`flex max-h-[min(80vh,720px)] w-full ${narrow ? "max-w-md" : "max-w-3xl"} flex-col overflow-hidden rounded-xl outline-none border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)]`}
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

export function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      narrow
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md border border-[var(--sf-hairline-strong)] px-3 py-1.5 text-[13px] text-[var(--sf-text-2)]">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-md bg-[var(--sf-text-1)] px-3 py-1.5 text-[13px] font-medium text-[var(--sf-bg,#0b0b0c)] disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2 px-4 py-4 text-[13px] leading-[1.5] text-[var(--sf-text-2)]">{children}</div>
    </Dialog>
  );
}
