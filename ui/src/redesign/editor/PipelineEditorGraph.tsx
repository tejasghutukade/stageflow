import { useRef, useState } from "react";
import { LuMaximize, LuMinus, LuPlus } from "react-icons/lu";
import type { DraftPackagePayload } from "../../api";
import { PipelineDagTrack } from "../../components/PipelineDagTrack";
import {
  DEFAULT_GRAPH_VIEW,
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  fitGraphView,
  stepZoom,
} from "../workshop/graph/graphViewport";
import type { GraphView } from "../workshop/graph/graphViewport";
import { buildEditorDag } from "./buildEditorDag";

export type PipelineEditorGraphProps = {
  draft: DraftPackagePayload;
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
  onAddStage: () => void;
};

export function PipelineEditorGraph({
  draft,
  selectedStageId,
  onSelectStage,
  onAddStage,
}: PipelineEditorGraphProps) {
  const layout = buildEditorDag(draft, selectedStageId);
  const [view, setView] = useState<GraphView>(DEFAULT_GRAPH_VIEW);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const empty = layout.stageCount === 0;

  const fit = () => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    setView(
      fitGraphView(
        { width: content.offsetWidth, height: content.offsetHeight },
        { width: viewport.clientWidth, height: viewport.clientHeight },
      ),
    );
  };

  return (
    <div className="editor-live-graph flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <div className="flex h-9 w-full shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-3.5">
        <span className="whitespace-nowrap text-xs font-medium text-[var(--sf-text-1)]">Live graph</span>
        <span className="whitespace-nowrap font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
          {layout.summary}
        </span>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          className="inline-flex h-6 shrink-0 items-center gap-[5px] rounded-md border border-[#ffffff1a] bg-[var(--sf-raised)] px-2 text-[var(--sf-text-1)] hover:bg-[var(--sf-raised)]"
          onClick={onAddStage}
          aria-keyshortcuts="A"
        >
          <LuPlus aria-hidden className="size-3 text-[var(--sf-text-2)]" />
          <span className="whitespace-nowrap text-xs">Add stage</span>
          <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">A</span>
        </button>
        <div className="inline-flex h-6 shrink-0 items-center rounded-md border border-[#ffffff1a] bg-[var(--sf-raised)]">
          <button
            type="button"
            className="flex size-[22px] items-center justify-center rounded-md text-[var(--sf-text-2)] hover:bg-[#1a1c21] disabled:cursor-default disabled:opacity-40"
            onClick={() => setView((current) => ({ ...current, zoom: stepZoom(current.zoom, -1) }))}
            disabled={empty || view.zoom <= GRAPH_ZOOM_MIN}
            aria-label="Zoom out"
          >
            <LuMinus aria-hidden className="size-3" />
          </button>
          <span className="min-w-[34px] px-0.5 text-center font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
            {Math.round(view.zoom * 100)}%
          </span>
          <button
            type="button"
            className="flex size-[22px] items-center justify-center rounded-md text-[var(--sf-text-2)] hover:bg-[#1a1c21] disabled:cursor-default disabled:opacity-40"
            onClick={() => setView((current) => ({ ...current, zoom: stepZoom(current.zoom, 1) }))}
            disabled={empty || view.zoom >= GRAPH_ZOOM_MAX}
            aria-label="Zoom in"
          >
            <LuPlus aria-hidden className="size-3" />
          </button>
        </div>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-[#ffffff1a] bg-[var(--sf-raised)] text-[var(--sf-text-2)] hover:bg-[#1a1c21] disabled:cursor-default disabled:opacity-40"
          onClick={fit}
          disabled={empty}
          aria-label="Fit"
          title="Fit"
        >
          <LuMaximize aria-hidden className="size-3" />
        </button>
      </div>
      {empty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="text-[13px] text-[var(--sf-text-3)]">No stages</p>
        </div>
      ) : (
        <div ref={viewportRef} className="relative min-h-0 w-full min-w-0 flex-1 overflow-auto">
          <div className="flex w-max min-w-full justify-center">
            <div
              ref={contentRef}
              className="flex shrink-0"
              style={{
                transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
                transformOrigin: "50% 0",
              }}
            >
              <PipelineDagTrack
                layers={layout.dagLayers}
                edges={layout.edges}
                layerIndices={layout.layerIndices}
                trackNodes={layout.trackNodes}
                selectedStageId={selectedStageId}
                onSelect={onSelectStage}
                mode="definition"
                selectPending
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
