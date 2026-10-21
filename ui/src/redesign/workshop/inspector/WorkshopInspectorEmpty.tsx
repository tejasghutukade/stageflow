import { LuArrowUpRight, LuMousePointerClick, LuWorkflow } from "react-icons/lu";

export type WorkshopInspectorEmptyProps = {
  stageCount: number;
  pipelineUntitled: boolean;
  onOpenPipelineTab: () => void;
};

export function WorkshopInspectorEmpty({
  stageCount,
  pipelineUntitled,
  onOpenPipelineTab,
}: WorkshopInspectorEmptyProps) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-3 px-8">
        <div className="flex size-10 items-center justify-center rounded-[10px] border border-[#ffffff12] bg-[#1a1c21]">
          <LuMousePointerClick className="size-4 text-[#8b8f98]" aria-hidden />
        </div>
        <div className="text-center text-[13px] font-medium leading-normal text-[#ecedee]">
          Select a stage to edit its fields
        </div>
        <div className="text-center text-xs leading-[1.45] text-[#8b8f98]">
          {stageCount === 0
            ? "Prompt, io, verify, on_verify_fail, and HITL settings show here once a stage exists."
            : "Click a stage on the graph to edit its prompt, io, verify, on_verify_fail, and HITL settings."}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenPipelineTab}
        className="mx-3.5 mb-3.5 flex items-start gap-2.5 rounded-[10px] border border-[#ffffff12] bg-[#0f1013] px-3 py-2.5 text-left hover:border-[#ffffff1a] hover:bg-[#121317]"
      >
        <LuWorkflow className="mt-0.5 size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs font-medium leading-normal text-[#ecedee]">Pipeline tab</span>
          <span className="text-xs leading-[1.45] text-[#8b8f98]">
            {pipelineUntitled
              ? "Set the pipeline id, entry stage, and routing before you add stages."
              : "Edit the pipeline id, default model, and how stages connect."}
          </span>
        </span>
        <LuArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
      </button>
    </div>
  );
}
