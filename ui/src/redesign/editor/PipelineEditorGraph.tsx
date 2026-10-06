import type { DraftPackagePayload, PipelineStageListing } from "../../api";
import { PipelineDagTrack } from "../../components/PipelineDagTrack";
import { PipelineTrack } from "../../components/PipelineTrack";
import { buildEditorDag } from "./buildEditorDag";

export type PipelineEditorGraphProps = {
  draft: DraftPackagePayload;
  listingStages?: PipelineStageListing[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
};

export function PipelineEditorGraph({
  draft,
  listingStages,
  selectedStageId,
  onSelectStage,
}: PipelineEditorGraphProps) {
  const layout = buildEditorDag(draft, listingStages, selectedStageId);

  if (layout.mode === "linear" && layout.linearStages) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-[var(--sf-ground)] px-0 py-4">
        <PipelineTrack
          stages={layout.linearStages}
          mode="definition"
          onSelect={onSelectStage}
        />
      </div>
    );
  }

  if (
    layout.mode === "dag" &&
    layout.dagLayers &&
    layout.layerIndices &&
    layout.trackNodes &&
    layout.edges
  ) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-[var(--sf-ground)] px-0 py-4 [background-image:radial-gradient(circle,_rgba(255,255,255,0.07)_0%,_rgba(0,0,0,0)_100%)]">
        <PipelineDagTrack
          layers={layout.dagLayers}
          edges={layout.edges}
          layerIndices={layout.layerIndices}
          trackNodes={layout.trackNodes}
          selectedStageId={selectedStageId}
          onSelect={onSelectStage}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center bg-[var(--sf-ground)]">
      <p className="text-[13px] text-[var(--sf-text-3)]">No stages</p>
    </div>
  );
}
