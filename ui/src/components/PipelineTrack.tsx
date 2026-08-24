import { Fragment } from "react";
import { StageNode, type StageStatus } from "./StageNode";

export type TrackEnvelope = {
  summary?: string;
  artifactCount: number;
};

export type TrackStage = {
  id: string;
  label: string;
  status: StageStatus;
  meta?: string;
  selected?: boolean;
  envelope?: TrackEnvelope | null;
};

export type PipelineTrackMode = "run" | "definition";

export type PipelineTrackProps = {
  stages: TrackStage[];
  mode?: PipelineTrackMode;
  onSelect?: (stageId: string) => void;
  onEnvelopeClick?: (fromStageId: string) => void;
  activeEnvelopeId?: string | null;
};

function fileCountLabel(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

export function TrackWire({
  mode,
  flowed,
  envelope,
  fromStageId,
  selected,
  onEnvelopeClick,
}: {
  mode: PipelineTrackMode;
  flowed: boolean;
  envelope?: TrackEnvelope | null;
  fromStageId: string;
  selected?: boolean;
  onEnvelopeClick?: (fromStageId: string) => void;
}) {
  const idle = envelope == null;
  const label = idle
    ? "no envelope yet"
    : `envelope · ${fileCountLabel(envelope.artifactCount)}`;

  return (
    <span className="wire" data-flowed={flowed ? "true" : undefined}>
      <span className="wire__line"></span>
      {mode === "definition" ? null : (
        <>
          <button
            className="wire__env"
            disabled={idle || !onEnvelopeClick}
            data-selected={selected ? "true" : undefined}
            onClick={
              idle || !onEnvelopeClick
                ? undefined
                : () => onEnvelopeClick(fromStageId)
            }
          >
            {label}
          </button>
          {envelope?.summary ? (
            <span className="wire__summary">{envelope.summary}</span>
          ) : null}
        </>
      )}
    </span>
  );
}

export function PipelineTrack({
  stages,
  mode = "run",
  onSelect,
  onEnvelopeClick,
  activeEnvelopeId,
}: PipelineTrackProps) {
  return (
    <nav className="track" aria-label="Pipeline track">
      <div className="track__rail">
        {stages.map((stage, i) => (
          <Fragment key={stage.id}>
            <StageNode
              id={stage.id}
              label={stage.label}
              status={stage.status}
              index={i}
              meta={stage.meta}
              selected={stage.selected}
              onClick={
                onSelect && stage.status !== "pending"
                  ? () => onSelect(stage.id)
                  : undefined
              }
            />
            {i < stages.length - 1 ? (
              <TrackWire
                mode={mode}
                flowed={stage.envelope != null}
                envelope={stage.envelope}
                fromStageId={stage.id}
                selected={activeEnvelopeId === stage.id}
                onEnvelopeClick={onEnvelopeClick}
              />
            ) : null}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}
