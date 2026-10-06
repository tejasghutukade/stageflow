export type ResumeAutosaveBannerProps = {
  updatedAt: string;
  onResume: () => void;
  onDismiss: () => void;
};

export function ResumeAutosaveBanner({
  updatedAt,
  onResume,
  onDismiss,
}: ResumeAutosaveBannerProps) {
  const when = new Date(updatedAt).toLocaleString();
  return (
    <div className="sf-workshop-banner" role="status">
      <span>Autosaved draft from {when}</span>
      <div className="sf-workshop-banner__actions">
        <button type="button" className="sf-btn sf-btn--primary sf-btn--sm" onClick={onResume}>
          Resume
        </button>
        <button type="button" className="sf-btn sf-btn--ghost sf-btn--sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
