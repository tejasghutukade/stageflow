import type { PipelineTrackEdge, PipelineTrackNode } from "../api";
import type { DagTrackNode } from "./PipelineDagTrack";
import { PipelineDagTrack } from "./PipelineDagTrack";
import { PipelineTrack, type TrackStage } from "./PipelineTrack";
import { TrackDetailList, type TrackDetailRow } from "./TrackDetailList";

export type TrackLayout =
  | {
      mode: "linear";
      linearStages: TrackStage[];
    }
  | {
      mode: "dag";
      dagLayers: DagTrackNode[][];
      layerIndices: number[];
      trackNodes: PipelineTrackNode[];
      edges: PipelineTrackEdge[];
    };

export type RunTrackProps = {
  trackLayout: TrackLayout;
  detailListRows: TrackDetailRow[];
  listHeader?: string;
  selectedStageId?: string | null;
  onSelect?: (stageId: string) => void;
  onEnvelopeClick?: (fromStageId: string) => void;
  activeEnvelopeId?: string | null;
  retryingStageIds?: ReadonlySet<string>;
  onRetryStage?: (stageId: string) => void;
  abandoningStageId?: string | null;
  onAbandonStage?: (stageId: string) => void;
};

export function RunTrack({
  trackLayout,
  detailListRows,
  listHeader,
  selectedStageId,
  onSelect,
  onEnvelopeClick,
  activeEnvelopeId,
  retryingStageIds,
  onRetryStage,
  abandoningStageId,
  onAbandonStage,
}: RunTrackProps) {
  const hasSummary =
    trackLayout.mode === "linear"
      ? trackLayout.linearStages.length > 0
      : trackLayout.dagLayers.some((layer) => layer.length > 0);

  if (!hasSummary && detailListRows.length === 0) return null;

  return (
    <div className="track-band">
      {trackLayout.mode === "linear" ? (
        <PipelineTrack
          stages={trackLayout.linearStages}
          onSelect={onSelect}
          onEnvelopeClick={onEnvelopeClick}
          activeEnvelopeId={activeEnvelopeId}
        />
      ) : (
        <PipelineDagTrack
          layers={trackLayout.dagLayers}
          edges={trackLayout.edges}
          layerIndices={trackLayout.layerIndices}
          trackNodes={trackLayout.trackNodes}
          selectedStageId={selectedStageId}
          onSelect={onSelect}
          onEnvelopeClick={onEnvelopeClick}
          activeEnvelopeId={activeEnvelopeId}
        />
      )}
      {listHeader ? (
        <p className="track-band__waiting-header px-3 py-2 font-sans text-[13px] text-[var(--sf-needs)]">
          {listHeader}
        </p>
      ) : null}
      {detailListRows.length > 0 ? (
        <TrackDetailList
          rows={detailListRows}
          selectedStageId={selectedStageId}
          onSelect={onSelect}
          retryingStageIds={retryingStageIds}
          onRetryStage={onRetryStage}
          abandoningStageId={abandoningStageId}
          onAbandonStage={onAbandonStage}
        />
      ) : null}
    </div>
  );
}
