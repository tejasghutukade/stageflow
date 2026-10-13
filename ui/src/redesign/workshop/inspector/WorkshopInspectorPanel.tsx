import { useEffect, useRef, useState } from "react";
import { LuTrash2, LuX } from "react-icons/lu";
import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import { WorkshopInspectorEmpty } from "./WorkshopInspectorEmpty";
import { WorkshopPipelineInspector } from "./WorkshopPipelineInspector";
import { WorkshopStageInspector } from "./WorkshopStageInspector";
import { getStageForm, isUntitledPipelineId } from "./stageFields";

export type WorkshopInspectorPanelProps = {
  draft: DraftPackagePayload;
  baseline: DraftPackagePayload | null;
  selectedStageId: string | null;
  tab: "stage" | "pipeline";
  onTabChange: (tab: "stage" | "pipeline") => void;
  onDraftChange: (draft: DraftPackagePayload) => void;
  onDeleteStage: (stageId: string) => void;
  onRenameStage: (fromId: string, toId: string) => void;
  findings: ValidationFinding[];
  models: string[];
  defaultModel: string | null;
  focusField?: { stageId: string; field: string; nonce: number } | null;
  pipelinePath?: string | null;
};

function TabButton({
  active,
  label,
  dot = false,
  onClick,
}: {
  active: boolean;
  label: string;
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "flex items-center gap-1.5 border-b-2 border-b-[#ecedee] text-[13px] font-medium leading-normal text-[#ecedee]"
          : "flex items-center gap-1.5 border-b-2 border-b-transparent text-[13px] leading-normal text-[#a7aab2] hover:text-[#ecedee]"
      }
    >
      {label}
      {dot ? (
        <>
          <span className="block size-1.5 rounded-full bg-[#a7aab2]" aria-hidden />
          <span className="sr-only">needs attention</span>
        </>
      ) : null}
    </button>
  );
}

export function StageDeleteControl({
  stageId,
  onDelete,
}: {
  stageId: string;
  onDelete: (stageId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setConfirming(false);
  }, [stageId]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={`Delete stage ${stageId}`}
        title="Delete stage"
        onClick={() => setConfirming(true)}
        className="flex size-6 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee]"
      >
        <LuTrash2 className="size-3.5" aria-hidden />
      </button>
    );
  }

  return (
    <div
      className="flex items-center gap-1"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setConfirming(false);
        }
      }}
    >
      <span className="whitespace-nowrap text-xs leading-normal text-[#a7aab2]">Delete stage?</span>
      <button
        ref={confirmRef}
        type="button"
        onClick={() => {
          setConfirming(false);
          onDelete(stageId);
        }}
        className="flex h-6 items-center rounded-md border border-[#f2645a47] bg-[#f2645a1a] px-2 text-xs font-medium leading-normal text-[#f2645a] hover:bg-[#f2645a2b]"
      >
        Delete
      </button>
      <button
        type="button"
        aria-label="Cancel delete"
        onClick={() => setConfirming(false)}
        className="flex size-6 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee]"
      >
        <LuX className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function WorkshopInspectorPanel({
  draft,
  baseline,
  selectedStageId,
  tab,
  onTabChange,
  onDraftChange,
  onDeleteStage,
  onRenameStage,
  findings,
  models,
  defaultModel,
  focusField,
  pipelinePath,
}: WorkshopInspectorPanelProps) {
  const handledNonce = useRef<number | null>(null);
  const stageExists = selectedStageId !== null && getStageForm(draft, selectedStageId) !== null;
  const focusMatches =
    focusField != null &&
    focusField.stageId === selectedStageId &&
    focusField.nonce !== handledNonce.current;

  useEffect(() => {
    if (focusMatches && tab !== "stage") onTabChange("stage");
  }, [focusMatches, focusField?.nonce]);

  const showStage = tab === "stage" && stageExists;

  return (
    <aside
      aria-label="Inspector"
      className="flex w-[300px] min-h-0 min-w-0 shrink-0 flex-col overflow-clip border-l border-l-[#ffffff12] bg-[#131418] [font-family:Geist,_sans-serif]"
    >
      <div
        role="tablist"
        className="flex h-10 w-full shrink-0 items-stretch gap-4 border-b border-b-[#ffffff12] px-3.5"
      >
        <TabButton active={tab === "stage"} label="Stage" onClick={() => onTabChange("stage")} />
        <TabButton
          active={tab === "pipeline"}
          label="Pipeline"
          dot={isUntitledPipelineId(draft.pipeline.id)}
          onClick={() => onTabChange("pipeline")}
        />
        <div className="block flex-1" />
        {showStage ? (
          <div className="flex items-center">
            <StageDeleteControl stageId={selectedStageId!} onDelete={onDeleteStage} />
          </div>
        ) : null}
      </div>

      {tab === "pipeline" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkshopPipelineInspector
            draft={draft}
            baseline={baseline}
            findings={findings}
            models={models}
            defaultModel={defaultModel}
            onDraftChange={onDraftChange}
            pipelinePath={pipelinePath}
          />
        </div>
      ) : showStage ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkshopStageInspector
            key={selectedStageId!}
            draft={draft}
            baseline={baseline}
            stageId={selectedStageId!}
            findings={findings}
            models={models}
            defaultModel={defaultModel}
            onDraftChange={onDraftChange}
            onRenameStage={onRenameStage}
            focusRequest={
              focusMatches && tab === "stage"
                ? { field: focusField!.field, nonce: focusField!.nonce }
                : null
            }
            onFocusHandled={() => {
              if (focusField) handledNonce.current = focusField.nonce;
            }}
          />
        </div>
      ) : (
        <WorkshopInspectorEmpty
          stageCount={draft.pipeline.stages.length}
          pipelineUntitled={isUntitledPipelineId(draft.pipeline.id)}
          onOpenPipelineTab={() => onTabChange("pipeline")}
        />
      )}
    </aside>
  );
}
