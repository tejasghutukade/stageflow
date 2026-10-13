import { LuGitFork, LuLayoutGrid, LuMaximize, LuMinus, LuPlus } from "react-icons/lu";

export type WorkshopCanvasToolbarProps = {
  stageCount: number;
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  viewDisabled?: boolean;
  onAddStage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onAutoLayout: () => void;
};

const MONO = "font-['Geist_Mono',monospace]";
const CONTROL =
  "flex h-6 shrink-0 items-center rounded-md border border-[#ffffff1a] bg-[#131418] transition-colors";
const ICON_BUTTON =
  "flex size-[22px] items-center justify-center rounded-md text-[#a7aab2] hover:bg-[#1a1c21] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

export function WorkshopCanvasToolbar({
  stageCount,
  zoom,
  canZoomIn,
  canZoomOut,
  viewDisabled = false,
  onAddStage,
  onZoomIn,
  onZoomOut,
  onFit,
  onAutoLayout,
}: WorkshopCanvasToolbarProps) {
  return (
    <div className="flex h-9 w-full shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-3.5">
      <LuGitFork aria-hidden className="size-[13px] shrink-0 text-[#8b8f98]" />
      <span className="whitespace-nowrap text-xs font-medium text-[#ecedee]">Draft graph</span>
      <span className={`${MONO} whitespace-nowrap text-[11px] text-[#8b8f98]`}>
        {stageCount} {stageCount === 1 ? "stage" : "stages"}
      </span>
      <span className="min-w-0 flex-1" />
      <button
        type="button"
        className={`${CONTROL} gap-[5px] px-2 hover:bg-[#1a1c21]`}
        onClick={onAddStage}
        aria-keyshortcuts="A"
      >
        <LuPlus aria-hidden className="size-3 text-[#a7aab2]" />
        <span className="whitespace-nowrap text-xs text-[#ecedee]">Add stage</span>
        <span className={`${MONO} text-[11px] text-[#8b8f98]`}>A</span>
      </button>
      <div className={CONTROL}>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={onZoomOut}
          disabled={viewDisabled || !canZoomOut}
          aria-label="Zoom out"
        >
          <LuMinus aria-hidden className="size-3" />
        </button>
        <span className={`${MONO} min-w-[34px] px-0.5 text-center text-[11px] text-[#a7aab2]`}>
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={onZoomIn}
          disabled={viewDisabled || !canZoomIn}
          aria-label="Zoom in"
        >
          <LuPlus aria-hidden className="size-3" />
        </button>
      </div>
      <button
        type="button"
        className={`${CONTROL} size-6 justify-center hover:bg-[#1a1c21] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-[#131418]`}
        onClick={onFit}
        disabled={viewDisabled}
        aria-label="Fit to view"
        title="Fit to view"
      >
        <LuMaximize aria-hidden className="size-3 text-[#a7aab2]" />
      </button>
      <button
        type="button"
        className={`${CONTROL} gap-[5px] px-2 hover:bg-[#1a1c21] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-[#131418]`}
        onClick={onAutoLayout}
        disabled={viewDisabled}
      >
        <LuLayoutGrid aria-hidden className="size-3 text-[#a7aab2]" />
        <span className="whitespace-nowrap text-xs text-[#ecedee]">Auto layout</span>
      </button>
    </div>
  );
}
