import { useEffect, type ReactNode } from "react";
import { LuX } from "react-icons/lu";
import { useOverlayChrome } from "../../overlay/useOverlayChrome";
import { MODAL_SCRIM_PT, OVERLAY_SCRIM_CLASS } from "../../overlay/overlayScrimClasses";

export const MONO = "font-['Geist_Mono',monospace]";
export const LABEL = "text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]";
export const INPUT =
  "h-8 w-full rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2.5 text-[13px] text-[var(--sf-text-1)] outline-none focus:border-[#ecedee73]";
export const TEXTAREA =
  "w-full rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2.5 py-2 text-xs text-[var(--sf-text-1)] outline-none focus:border-[#ecedee73]";
export const BTN =
  "flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)] disabled:cursor-default disabled:opacity-50";
export const BTN_PRIMARY =
  "flex h-8 items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)] disabled:cursor-default disabled:opacity-50";

export function DialogShell({
  title,
  subtitle,
  width = "w-[720px]",
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  width?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useOverlayChrome(true);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={`${OVERLAY_SCRIM_CLASS} ${MODAL_SCRIM_PT}`} role="presentation" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} tabIndex={-1} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex max-h-[calc(100vh-88px)] ${width} max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[14px] border border-[#ffffff1a] bg-[var(--sf-panel)] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]`}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-b-[var(--sf-hairline)] px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-[17px] font-semibold tracking-[-0.17px] text-[var(--sf-text-1)]">{title}</h2>
            {subtitle ? <p className="text-[13px] text-[var(--sf-text-2)]">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)]"
          >
            <LuX className="size-4" aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-t-[var(--sf-hairline)] px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
