import type { StageSnapshot } from "../../api";
import { formatEventTime } from "./runEventsView";

export type RunDetailCenterTab =
  | "transcript"
  | "events"
  | "envelope"
  | "artifacts";

function stageStartedAt(stage: StageSnapshot): string | undefined {
  for (const ev of stage.events) {
    if (ev.event === "started" && ev.at) return ev.at;
  }
  return stage.events[0]?.at;
}

export function RunDetailCenterTabs({
  tab,
  onTabChange,
  stage,
  stageLabel,
  eventCount,
  artifactCount,
}: {
  tab: RunDetailCenterTab;
  onTabChange: (tab: RunDetailCenterTab) => void;
  stage: StageSnapshot;
  stageLabel: string;
  eventCount: number;
  artifactCount: number;
}) {
  const started = formatEventTime(stageStartedAt(stage));
  const attemptMeta = `attempt ${stage.attempt_count} · ${started}`;

  const tabs: {
    id: RunDetailCenterTab;
    label: string;
    count?: string;
    prefix?: string;
  }[] = [
    {
      id: "transcript",
      label: "Transcript",
      prefix: stageLabel,
    },
    {
      id: "events",
      label: "Events",
      count: String(eventCount),
    },
    { id: "envelope", label: "Envelope" },
    {
      id: "artifacts",
      label: "Artifacts",
      count: `(${artifactCount})`,
    },
  ];

  return (
    <div className="flex h-10 shrink-0 items-end justify-between gap-4 border-b border-b-[#ffffff12] px-6">
      <div className="flex items-end gap-5">
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`flex items-center gap-1.5 border-b-2 pb-2 text-[13px] ${
                active
                  ? "border-b-[#ecedee] font-medium text-[var(--sf-text-1)]"
                  : "border-b-transparent text-[#a7aab2]"
              }`}
              onClick={() => onTabChange(t.id)}
            >
              {t.id === "transcript" && t.prefix ? (
                <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-needs)]">
                  {t.prefix}
                </span>
              ) : null}
              {t.label}
              {t.count ? (
                <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
                  {t.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <span className="pb-2 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
        {attemptMeta}
      </span>
    </div>
  );
}
