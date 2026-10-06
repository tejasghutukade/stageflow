import type { DraftPackagePayload } from "../../api";
import { Inspector } from "../shell/Inspector";
import { stageIdFromRef, updateStageField } from "./draftMutators";

export type PipelineEditorInspectorProps = {
  draft: DraftPackagePayload;
  selectedStageId: string | null;
  onDraftChange: (draft: DraftPackagePayload) => void;
};

function bodyForStage(
  draft: DraftPackagePayload,
  stageId: string,
): Record<string, unknown> | null {
  const inline = draft.pipeline.stages.find(
    (stage, index) => stageIdFromRef(stage, index) === stageId,
  );
  if (inline) return inline;
  const file = (draft.stages ?? []).find((art) => {
    if (typeof art.body.id === "string" && art.body.id === stageId) return true;
    const pathId = art.path.replace(/^\.\//, "").replace(/\.ya?ml$/, "");
    return pathId === stageId;
  });
  return file?.body ?? null;
}

export function PipelineEditorInspector({
  draft,
  selectedStageId,
  onDraftChange,
}: PipelineEditorInspectorProps) {
  if (!selectedStageId) {
    return (
      <Inspector title="Stage" className="w-[300px]">
        <p className="text-[13px] text-[var(--sf-text-3)]">
          Select a stage on the graph
        </p>
      </Inspector>
    );
  }

  const body = bodyForStage(draft, selectedStageId);
  const model =
    typeof body?.model === "string"
      ? body.model
      : typeof draft.pipeline.model === "string"
        ? draft.pipeline.model
        : "";
  const prompt =
    typeof body?.system_prompt === "string"
      ? body.system_prompt
      : typeof body?.systemPrompt === "string"
        ? body.systemPrompt
        : "";

  return (
    <Inspector title={selectedStageId} className="w-[300px]">
      <label className="sf-field">
        <span className="sf-field__label">Model</span>
        <input
          className="sf-field__input sf-mono"
          value={model}
          onChange={(event) =>
            onDraftChange(
              updateStageField(
                draft,
                selectedStageId,
                "model",
                event.target.value,
              ),
            )
          }
        />
      </label>
      <label className="sf-field">
        <span className="sf-field__label">System prompt</span>
        <textarea
          className="sf-field__textarea sf-mono"
          rows={8}
          value={prompt}
          onChange={(event) =>
            onDraftChange(
              updateStageField(
                draft,
                selectedStageId,
                "system_prompt",
                event.target.value,
              ),
            )
          }
        />
      </label>
    </Inspector>
  );
}
