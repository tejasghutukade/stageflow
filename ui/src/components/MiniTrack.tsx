import { Fragment } from "react";
import type { StageSnapshot } from "../api";
import { useRedesign } from "../redesign/flag";
import { statusSignalFromStageStatus } from "../redesign/statusSignal";
import { ringGlyph, ringStatus } from "../status/runStatus";

export type MiniStage = { id: string; status: StageSnapshot["status"] };

export type MiniTrackProps = {
  stages: MiniStage[];
  label?: string;
  variant?: "rings" | "bar";
};

function barSegmentClass(status: MiniStage["status"]): string {
  if (status === "pending") return "sf-track__seg--empty";
  const signal = statusSignalFromStageStatus(status);
  return `sf-track__seg--${signal}`;
}

export function MiniTrack({ stages, label, variant }: MiniTrackProps) {
  const redesign = useRedesign();
  const mode = variant ?? (redesign ? "bar" : "rings");

  if (stages.length === 0) return null;

  if (mode === "bar") {
    return (
      <span>
        <span className="sf-track" aria-hidden="true">
          {stages.map((stage) => (
            <i
              key={stage.id}
              className={`sf-track__seg ${barSegmentClass(stage.status)}`}
            />
          ))}
        </span>
        {label ? <span className="sf-track__label">{label}</span> : null}
      </span>
    );
  }

  return (
    <span>
      <span className="mini" aria-hidden="true">
        {stages.map((stage, i) => {
          const ring = ringStatus(stage.status);
          const glyph = ringGlyph(ring) || String(i + 1);
          const flowed = i > 0 && stages[i - 1]?.status === "succeeded";
          return (
            <Fragment key={stage.id}>
              {i > 0 ? (
                <i
                  className="mini__w"
                  data-flowed={flowed ? "true" : undefined}
                ></i>
              ) : null}
              <i
                className="mini__n"
                data-s={ring !== "pending" ? ring : undefined}
              >
                {glyph}
              </i>
            </Fragment>
          );
        })}
      </span>
      {label ? <span className="mini__label">{label}</span> : null}
    </span>
  );
}
