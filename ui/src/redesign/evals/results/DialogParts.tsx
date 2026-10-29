import { BTN, BTN_PRIMARY } from "../datasets/DialogShell";

export function ErrorBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-lg bg-[var(--sf-fail-bg)] px-3 py-2 text-[13px] text-[var(--sf-fail)]">
      {text}
    </p>
  );
}

/** The footer both tuning dialogs show once the eval file has changed. */
export function SavedFooter({ onClose, onCheckNow }: { onClose: () => void; onCheckNow: () => void }) {
  return (
    <>
      <span className="text-xs text-[var(--sf-text-3)]">The judge changed, so its old check is out of date.</span>
      <span className="flex gap-2">
        <button type="button" className={BTN} onClick={onClose}>
          Later
        </button>
        <button type="button" className={BTN_PRIMARY} onClick={onCheckNow}>
          Check the judge now
        </button>
      </span>
    </>
  );
}
