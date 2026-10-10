import type {
  DraftPackagePayload,
  PipelineListing,
  ValidationFinding,
} from "../../api";
import {
  WorkshopStageInspector,
  type StageFocusRequest,
} from "../workshop/inspector/WorkshopStageInspector";
import { getStageForm } from "../workshop/inspector/stageFields";
import { stageUsedByCount } from "./pipelineEditorModel";

export type PipelineEditorInspectorProps = {
  draft: DraftPackagePayload;
  baseline: DraftPackagePayload | null;
  selectedStageId: string | null;
  findings: ValidationFinding[];
  models: string[];
  defaultModel: string | null;
  pipelines: readonly PipelineListing[] | null;
  projectRoot?: string;
  onDraftChange: (draft: DraftPackagePayload) => void;
  onRenameStage: (fromId: string, toId: string) => void;
  focusRequest?: StageFocusRequest | null;
};

export function PipelineEditorInspector({
  draft,
  baseline,
  selectedStageId,
  findings,
  models,
  defaultModel,
  pipelines,
  projectRoot,
  onDraftChange,
  onRenameStage,
  focusRequest = null,
}: PipelineEditorInspectorProps) {
  const form = selectedStageId ? getStageForm(draft, selectedStageId) : null;

  if (!selectedStageId || !form) {
    return (
      <aside
        aria-label="Stage inspector"
        className="flex w-[340px] shrink-0 flex-col border-l border-l-[#ffffff12] bg-[#131418] [font-family:Geist,_sans-serif]"
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[13px] font-medium text-[#ecedee]">
            Click a stage on the graph
          </p>
          <p className="text-xs leading-[1.45] text-[#8b8f98]">
            Prompt, io, verify, on_verify_fail, and HITL settings show here.
          </p>
        </div>
      </aside>
    );
  }

  const usedByCount = stageUsedByCount(pipelines, {
    id: form.id,
    path: form.path,
    projectRoot,
  });

  return (
    <aside
      aria-label="Stage inspector"
      className="flex w-[340px] min-h-0 shrink-0 flex-col overflow-hidden border-l border-l-[#ffffff12] bg-[#131418] [font-family:Geist,_sans-serif]"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkshopStageInspector
          key={selectedStageId}
          draft={draft}
          baseline={baseline}
          stageId={selectedStageId}
          findings={findings}
          models={models}
          defaultModel={defaultModel}
          onDraftChange={onDraftChange}
          onRenameStage={onRenameStage}
          usedByCount={usedByCount}
          focusRequest={focusRequest}
        />
      </div>
    </aside>
  );
}
