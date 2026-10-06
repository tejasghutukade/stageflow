export type DiskChangeBannerProps = {
  changedPaths: string[];
  onReload: () => void;
  onKeep: () => void;
};

export function DiskChangeBanner({
  changedPaths,
  onReload,
  onKeep,
}: DiskChangeBannerProps) {
  const preview = changedPaths.slice(0, 3).join(", ");
  const more =
    changedPaths.length > 3 ? ` +${changedPaths.length - 3} more` : "";
  return (
    <div className="sf-workshop-banner sf-workshop-banner--warn" role="alert">
      <span>
        Catalog files changed on disk ({preview}
        {more})
      </span>
      <div className="sf-workshop-banner__actions">
        <button type="button" className="sf-btn sf-btn--ghost sf-btn--sm" onClick={onReload}>
          Reload from disk
        </button>
        <button type="button" className="sf-btn sf-btn--primary sf-btn--sm" onClick={onKeep}>
          Keep workshop draft
        </button>
      </div>
    </div>
  );
}
