import { LuFlag, LuMessageSquareText, LuPlus } from "react-icons/lu";
import { Keycap } from "../../Keycap";

export type WorkshopEmptyCanvasProps = {
  onAddStage: () => void;
};

export function WorkshopEmptyCanvas({ onAddStage }: WorkshopEmptyCanvasProps) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 [background-image:radial-gradient(circle,_rgba(255,_255,_255,_0.07)_0%,_rgba(0,_0,_0,_0)_100%)]">
      <div className="flex h-14 w-[184px] items-center gap-2.5 rounded-[10px] border border-dashed border-[#ffffff33] bg-[#0c0d0f] px-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed border-[#ffffff26]">
          <LuFlag aria-hidden className="size-3.5 text-[#8b8f98]" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="whitespace-nowrap text-[13px] font-medium text-[#a7aab2]">Entry</span>
          <span className="whitespace-nowrap font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
            no stage yet
          </span>
        </div>
      </div>
      <div className="h-[18px] w-px border-l border-l-[#ffffff26]" />
      <button
        type="button"
        className="flex h-8 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 hover:bg-[#202227]"
        onClick={onAddStage}
        aria-keyshortcuts="A"
      >
        <LuPlus aria-hidden className="size-3.5 text-[#ecedee]" />
        <span className="whitespace-nowrap text-[13px] font-medium text-[#ecedee]">Add first stage</span>
        <Keycap className="bg-[#131418]">A</Keycap>
      </button>
      <div className="flex max-w-[320px] items-center gap-1.5">
        <LuMessageSquareText aria-hidden className="size-3.5 shrink-0 text-[#8b8f98]" />
        <span className="text-center text-xs leading-[1.45] text-[#8b8f98]">
          Or tell the agent what you need. Stages appear here as you talk.
        </span>
      </div>
    </div>
  );
}
