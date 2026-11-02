import { useEffect, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LuX } from "react-icons/lu";

function useEscape(onClose: () => void, disabled = false) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, disabled]);
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#1a1c21]"
    >
      <LuX className="block size-4" aria-hidden />
    </button>
  );
}

export function IdentityDialog({
  title,
  subtitle,
  titleId,
  busy = false,
  width = 640,
  footer,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  subtitle?: string;
  titleId: string;
  busy?: boolean;
  width?: number;
  footer: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  useEscape(onClose, busy);
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#040506a8] p-4"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="flex max-h-[92vh] w-full flex-col rounded-xl border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-b-[#ffffff12] px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id={titleId} className="text-lg font-semibold tracking-[-0.36px] text-[#ecedee]">{title}</h2>
            {subtitle ? <p className="text-[13px] leading-normal text-[#a7aab2]">{subtitle}</p> : null}
          </div>
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-t-[#ffffff12] px-5 py-3">{footer}</div>
      </form>
    </div>,
    document.body,
  );
}

export function IdentityDrawer({
  title,
  eyebrow,
  titleAddon,
  onClose,
  children,
}: {
  title: string;
  eyebrow?: string;
  titleAddon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEscape(onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex justify-end bg-[#040506a8]" role="presentation" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-[460px] flex-col border-l border-l-[#ffffff1a] bg-[#131418] shadow-[-24px_0px_64px_rgba(0,0,0,0.5)]"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-b-[#ffffff12] px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {eyebrow ? (
              <span className="text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]">{eyebrow}</span>
            ) : null}
            <h2 className="truncate text-lg font-semibold tracking-[-0.36px] text-[#ecedee] [font-family:'Geist_Mono',_monospace]">{title}</h2>
            {titleAddon}
          </div>
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
