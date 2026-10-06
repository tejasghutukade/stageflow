import { Fragment } from "react";
import type { RunDetail } from "../../api";
import type { WorkspaceTrackStage } from "../../workspace/resolveRunWorkspace";
import { signalIcon } from "../statusSignal";
import {
  buildRunGraphBandView,
  graphBandSelectedHint,
} from "./buildRunGraphBandView";

export type RunDetailGraphBandProps = {
  run: RunDetail;
  trackStages: WorkspaceTrackStage[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
};

function signalIconClass(signal: ReturnType<typeof buildRunGraphBandView>[number]["signal"]): string {
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

function readinessLineClass(
  node: ReturnType<typeof buildRunGraphBandView>[number],
): string {
  if (node.blocked) return "text-[var(--sf-text-2)]";
  if (node.signal === "needs") return "text-[#f5b544]";
  if (node.signal === "ok") return "font-['Geist_Mono',monospace] text-[#4cc38a]";
  if (node.signal === "fail") return "text-[#f2645a]";
  if (node.signal === "running") return "text-[var(--sf-running)]";
  return "font-['Geist_Mono',monospace] text-[var(--sf-text-2)]";
}

function GraphBandNodeCard({
  node,
  onSelect,
}: {
  node: ReturnType<typeof buildRunGraphBandView>[number];
  onSelect: (stageId: string) => void;
}) {
  const Icon = signalIcon(node.signal);
  const selectedNeeds = node.selected && node.signal === "needs";

  return (
    <button
      type="button"
      className={`flex w-[120px] shrink-0 flex-col gap-1 rounded-lg border p-2 text-left${
        node.selected ?
          selectedNeeds ?
            " border-[#f5b5444d] bg-[var(--sf-ground)] shadow-[0px_0px_12px_rgba(245,181,68,0.25)]"
          : " border-[var(--sf-needs)] bg-[var(--sf-active)]"
        : node.blocked ?
          " border-dashed border-[#a7aab28c] bg-[#1a1c21]"
        : " border-[#ffffff12] bg-[#1a1c21]"
      }`}
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
  selectedStageId,
  onSelectStage,
}: RunDetailGraphBandProps) {
  const nodes = buildRunGraphBandView(run, trackStages, selectedStageId);
  const selectedHint = graphBandSelectedHint(run, selectedStageId);

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
      <div className="min-h-[160px] flex-1 overflow-x-auto rounded-[10px] border border-[#ffffff12] bg-[var(--sf-ground)] p-4">
        <div className="flex min-w-max items-center">
          {nodes.map((node, index) => (
            <Fragment key={node.stageId}>
              {index > 0 ?
                <span
                  className="mx-0 block h-px w-[60px] shrink-0 bg-[#ffffff1f]"
                  aria-hidden="true"
                />
              : null}
              <GraphBandNodeCard node={node} onSelect={onSelectStage} />
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
