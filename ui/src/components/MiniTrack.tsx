import { Fragment } from "react";
import type { StageSnapshot } from "../api";
import { ringGlyph, ringStatus } from "../status/runStatus";

export type MiniStage = { id: string; status: StageSnapshot["status"] };

export type MiniTrackProps = {
  stages: MiniStage[];
  label?: string;
};

export function MiniTrack({ stages, label }: MiniTrackProps) {
  if (stages.length === 0) return null;

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
