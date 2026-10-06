import { useMemo } from "react";
import type { RunDetail } from "../../api";
import type { SpatialTrackLayout } from "../../track/layoutPipelineTrack";
import type { WorkspaceTrackStage } from "../../workspace/resolveRunWorkspace";
import { signalIcon } from "../statusSignal";
import {
  buildRunGraphBandView,
  graphBandSelectedHint,
} from "./buildRunGraphBandView";
import {
  graphBandEdgeSegment,
  layoutGraphBandTrack,
  type GraphBandNodeBox,
} from "./layoutGraphBandTrack";

export type RunDetailGraphBandProps = {
  run: RunDetail;
  trackStages: WorkspaceTrackStage[];
  spatialLayout: SpatialTrackLayout;
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
};

type GraphBandViewNode = ReturnType<typeof buildRunGraphBandView>[number];

function signalIconClass(signal: GraphBandViewNode["signal"]): string {
  switch (signal) {
    case "ok":
      return "text-[#4cc38a]";
    case "fail":
      return "text-[#f2645a]";
    case "needs":
      return "text-[#f5b544]";
    case "running":
      return "text-[var(--sf-running)]";
    default:
      return "text-[var(--sf-text-2)]";
  }
}

function readinessLineClass(node: GraphBandViewNode): string {
  if (node.blocked) return "text-[var(--sf-text-2)]";
  if (node.signal === "needs") return "text-[#f5b544]";
  if (node.signal === "ok") return "font-['Geist_Mono',monospace] text-[#4cc38a]";
  if (node.signal === "fail") return "text-[#f2645a]";
  if (node.signal === "running") return "text-[var(--sf-running)]";
  return "font-['Geist_Mono',monospace] text-[var(--sf-text-2)]";
}

function nodeCardClass(node: GraphBandViewNode): string {
  if (node.selected && node.signal === "needs") {
    return " w-[132px] border-[#f5b5444d] bg-[var(--sf-panel)] shadow-[0px_0px_12px_rgba(245,181,68,0.25)]";
  }
  if (node.selected) {
    return " w-[120px] border-[#ffffff47] bg-[var(--sf-active)]";
  }
  if (node.blocked) {
    return " w-[120px] border-dashed border-[#a7aab28c] bg-[var(--sf-raised)]";
  }
  return " w-[120px] border-[#ffffff12] bg-[var(--sf-raised)]";
}

function GraphBandNodeCard({
  node,
  box,
  onSelect,
}: {
  node: GraphBandViewNode;
  box: GraphBandNodeBox;
  onSelect: (stageId: string) => void;
}) {
  const Icon = signalIcon(node.signal);

  return (
    <button
      type="button"
      className={`absolute flex shrink-0 flex-col gap-1 rounded-lg border p-2 text-left${nodeCardClass(node)}`}
      style={{ left: box.x, top: box.y, width: box.width }}
      disabled={!node.clickable}
      onClick={node.clickable ? () => onSelect(node.stageId) : undefined}
      aria-current={node.selected ? "true" : undefined}
    >
      <span className="flex items-center gap-1.5">
        <Icon
          className={`size-3.5 shrink-0 ${signalIconClass(node.signal)}`}
          aria-hidden="true"
        />
        <span
          className={`truncate font-sans text-[13px] leading-normal ${
            node.selected ? "font-semibold text-[var(--sf-text-1)]"
            : node.titleMuted ? "text-[var(--sf-text-2)]"
            : "font-medium text-[var(--sf-text-1)]"
          }`}
        >
          {node.label}
        </span>
      </span>
      {node.blocked ?
        <span className="flex flex-col gap-0.5">
          <span className="font-sans text-[11px] font-medium leading-normal text-[var(--sf-text-2)]">
            {node.readinessLine}
          </span>
          {node.waitsLine ?
            <span className="font-sans text-[10px] leading-normal text-[var(--sf-text-3)]">
              {node.waitsLine}
            </span>
          : null}
        </span>
      : <span className={`font-sans text-[11px] font-medium leading-normal ${readinessLineClass(node)}`}>
          {node.readinessLine}
        </span>
      }
      {node.attemptLine ?
        <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
          {node.attemptLine}
        </span>
      : null}
    </button>
  );
}

export function RunDetailGraphBand({
  run,
  trackStages,
  spatialLayout,
  selectedStageId,
  onSelectStage,
}: RunDetailGraphBandProps) {
  const nodes = buildRunGraphBandView(run, trackStages, selectedStageId);
  const selectedHint = graphBandSelectedHint(run, selectedStageId);
  const bandLayout = useMemo(
    () => layoutGraphBandTrack(spatialLayout),
    [spatialLayout],
  );
  const nodeByStageId = useMemo(
    () => new Map(nodes.map((node) => [node.stageId, node])),
    [nodes],
  );
  const boxByStageId = useMemo(
    () => new Map(bandLayout.nodes.map((box) => [box.stageId, box])),
    [bandLayout.nodes],
  );

  if (nodes.length === 0) {
    return (
      <div className="flex w-full min-h-[200px] flex-col border-b border-b-[#ffffff12] px-6 pb-4 pt-3">
        <p className="font-sans text-[13px] text-[var(--sf-text-2)]">No stages yet.</p>
      </div>
    );
  }

  return (
    <div className="flex w-full min-h-[200px] flex-col border-b border-b-[#ffffff12] px-6 pb-4 pt-3">
      <div className="flex items-center justify-between pb-3 pt-0">
        <span className="font-sans text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          Pipeline track
        </span>
        {selectedHint ?
          <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
            selected: {selectedHint}
          </span>
        : null}
      </div>
      <div className="min-h-[160px] flex-1 overflow-x-auto rounded-[10px] border border-[#ffffff12] bg-[var(--sf-panel)] p-4">
        <div
          className="relative"
          style={{
            minWidth: bandLayout.width,
            minHeight: bandLayout.height,
          }}
        >
          {bandLayout.edges.map((edge) => {
            const from = boxByStageId.get(edge.from);
            const to = boxByStageId.get(edge.to);
            if (!from || !to) return null;
            const segment = graphBandEdgeSegment(from, to);
            if (!segment) return null;
            return (
              <span
                key={`${edge.from}-${edge.to}`}
                className="pointer-events-none absolute block h-px bg-[#ffffff1f]"
                style={{
                  left: segment.left,
                  top: segment.top,
                  width: segment.width,
                }}
                aria-hidden="true"
              />
            );
          })}
          {bandLayout.nodes.map((box) => {
            const node = nodeByStageId.get(box.stageId);
            if (!node) return null;
            return (
              <GraphBandNodeCard
                key={box.stageId}
                node={node}
                box={box}
                onSelect={onSelectStage}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
