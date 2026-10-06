export type RunDetailCenterTab =
  | "transcript"
  | "events"
  | "envelope"
  | "artifacts";

export function RunDetailCenterTabs({
  active,
  onChange,
  artifactCount,
}: {
  active: RunDetailCenterTab;
  onChange: (tab: RunDetailCenterTab) => void;
  artifactCount: number;
}) {
  const tabs: { id: RunDetailCenterTab; label: string; count?: number }[] = [
    { id: "transcript", label: "Transcript" },
    { id: "events", label: "Events" },
    { id: "envelope", label: "Envelope" },
    {
      id: "artifacts",
      label: "Artifacts",
      count: artifactCount > 0 ? artifactCount : undefined,
    },
  ];

  return (
    <div className="flex shrink-0 gap-1.5 border-b border-b-[#ffffff12] px-3 py-2">
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            className={`sf-btn sf-btn--sm flex items-center gap-1.5${
              selected ? " sf-btn--selected" : ""
            }`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count != null ? (
              <span className="rounded-sm bg-[var(--sf-raised)] px-[5px] font-['Geist_Mono',monospace] text-[10px] text-[var(--sf-text-2)]">
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
