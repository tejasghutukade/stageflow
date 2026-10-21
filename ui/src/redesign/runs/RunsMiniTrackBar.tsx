import type { MiniStage } from "../../components/MiniTrack";
import { statusSignalFromStageStatus } from "../statusSignal";

function segmentClass(status: MiniStage["status"]): string {
  const signal = statusSignalFromStageStatus(status);
  if (signal === "ok") return "bg-[var(--sf-ok)]";
  if (signal === "fail") return "bg-[var(--sf-fail)]";
  if (signal === "running") return "bg-[var(--sf-running)]";
  if (signal === "needs") return "bg-[var(--sf-needs)]";
  if (signal === "skipped") return "bg-[var(--sf-text-3)]";
  return "bg-[var(--sf-track-empty)]";
}

export function RunsMiniTrackBar({ stages }: { stages: MiniStage[] }) {
  if (stages.length === 0) return null;
  return (
    <div className="flex w-full gap-[3px]" aria-hidden="true">
      {stages.map((stage) => (
        <div
          key={stage.id}
          className={`block h-1.5 flex-1 rounded-full ${segmentClass(stage.status)}`}
        />
      ))}
    </div>
  );
}
