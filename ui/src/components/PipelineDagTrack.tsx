import type { PipelineTrackEdge } from "../api";
import { edgesBetweenLayers } from "../track/layoutPipelineTrack";
import type { PipelineTrackNode } from "../api";
import { StageNode } from "./StageNode";
import { TrackWire, type TrackEnvelope } from "./PipelineTrack";

export type DagTrackNode = {
  id: string;
  label: string;
  status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";
  stageStatus:
    | "pending"
    | "running"
    | "waiting_for_input"
    | "succeeded"
    | "failed"
    | "skipped";
  selected?: boolean;
  meta?: string;
  envelope?: TrackEnvelope | null;
  isWaitingAttention?: boolean;
};

export type PipelineDagTrackProps = {
  layers: DagTrackNode[][];
  edges: PipelineTrackEdge[];
  layerIndices: number[];
  trackNodes: PipelineTrackNode[];
  selectedStageId?: string | null;
  onSelect?: (stageId: string) => void;
  onEnvelopeClick?: (fromStageId: string) => void;
  activeEnvelopeId?: string | null;
};

function wireEnvelope(
  edge: PipelineTrackEdge,
  upstream: DagTrackNode | undefined,
): TrackEnvelope | null {
  const snapshotEnv = upstream?.envelope;
  if (snapshotEnv) {
    return {
      summary: edge.envelope_summary ?? snapshotEnv.summary,
      artifactCount: snapshotEnv.artifactCount,
    };
  }
  if (edge.envelope_summary) {
    return { summary: edge.envelope_summary, artifactCount: 0 };
  }
  return null;
}

export function PipelineDagTrack({
  layers,
  edges,
  layerIndices,
  trackNodes,
  onSelect,
  onEnvelopeClick,
  activeEnvelopeId,
}: PipelineDagTrackProps) {
  const nodeById = new Map(layers.flat().map((n) => [n.id, n]));

  return (
    <nav className="track" aria-label="Pipeline track">
      <div className="track-dag">
        {layers.map((layerNodes, layerIdx) => {
          const layerNum = layerIndices[layerIdx] ?? layerIdx;
          const prevLayerNum = layerIdx > 0 ? layerIndices[layerIdx - 1] : undefined;
          const gutterEdges =
            prevLayerNum != null
              ? edgesBetweenLayers(edges, trackNodes, prevLayerNum, layerNum)
              : [];

          return (
            <div key={layerNum} className="track-dag__segment">
              {layerIdx > 0 ? (
                <div className="track-dag__gutter" aria-hidden="true">
                  {gutterEdges.map((edge) => {
                    const upstream = nodeById.get(edge.from);
                    const envelope = wireEnvelope(edge, upstream);
                    const flowed = upstream?.stageStatus === "succeeded";
                    return (
                      <TrackWire
                        key={`${edge.from}-${edge.to}`}
                        mode="run"
                        flowed={flowed}
                        envelope={envelope}
                        fromStageId={edge.from}
                        selected={activeEnvelopeId === edge.from}
                        onEnvelopeClick={onEnvelopeClick}
                      />
                    );
                  })}
                </div>
              ) : null}
              <div className="track-dag__layer">
                {layerNodes.map((node) => (
                  <div
                    key={node.id}
                    className="track-dag__node"
                    data-waiting={node.isWaitingAttention ? "true" : undefined}
                  >
                    <StageNode
                      id={node.id}
                      label={node.label}
                      status={node.status}
                      meta={node.meta}
                      selected={node.selected}
                      onClick={
                        onSelect && node.stageStatus !== "pending"
                          ? () => onSelect(node.id)
                          : undefined
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
