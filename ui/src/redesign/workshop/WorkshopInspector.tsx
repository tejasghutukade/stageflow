import type { DraftPackagePayload } from "../../api";
import { Inspector } from "../shell/Inspector";
import { updateStageField } from "../editor/draftMutators";

export type WorkshopDraftStage = {
  stageId: string;
  title: string;
  promptSummary: string;
  ioSummary: string;
  verifySummary: string;
  hitlFlags: string[];
};

export type WorkshopInspectorProps = {
  tab: "stage" | "pipeline";
  onTabChange: (tab: "stage" | "pipeline") => void;
  draft: DraftPackagePayload;
  selectedStage: WorkshopDraftStage | null;
  onDraftChange: (draft: DraftPackagePayload) => void;
};

export function WorkshopInspector({
  tab,
  onTabChange,
  draft,
  selectedStage,
  onDraftChange,
}: WorkshopInspectorProps) {
  return (
    <aside className="sf-workshop-inspector">
      <div className="sf-workshop-inspector__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "stage"}
          className={`sf-workshop-inspector__tab${tab === "stage" ? " sf-workshop-inspector__tab--active" : ""}`}
          onClick={() => onTabChange("stage")}
        >
          Stage
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pipeline"}
          className={`sf-workshop-inspector__tab${tab === "pipeline" ? " sf-workshop-inspector__tab--active" : ""}`}
          onClick={() => onTabChange("pipeline")}
        >
          Pipeline
        </button>
      </div>
      {tab === "pipeline" ? (
        <Inspector title="Pipeline">
          <label className="sf-field">
            <span className="sf-field__label">Pipeline id</span>
            <input
              className="sf-field__input sf-mono"
              value={draft.pipeline.id}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  pipeline: { ...draft.pipeline, id: event.target.value },
                })
              }
            />
          </label>
        </Inspector>
      ) : selectedStage ? (
        <Inspector title={selectedStage.title}>
          <label className="sf-field">
            <span className="sf-field__label">System prompt</span>
            <textarea
              className="sf-field__textarea sf-mono"
              rows={6}
              value={selectedStage.promptSummary}
              onChange={(event) =>
                onDraftChange(
                  updateStageField(
                    draft,
                    selectedStage.stageId,
                    "system_prompt",
                    event.target.value,
                  ),
                )
              }
            />
          </label>
          <p className="sf-inspector__muted sf-mono">{selectedStage.ioSummary}</p>
          <p className="sf-inspector__muted sf-mono">
            {selectedStage.verifySummary}
          </p>
        </Inspector>
      ) : (
        <Inspector title="Stage">
          <p className="sf-inspector__muted">Select a stage on the canvas</p>
        </Inspector>
      )}
    </aside>
  );
}
