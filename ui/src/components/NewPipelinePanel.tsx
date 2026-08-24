import { useEffect, useRef, useState } from "react";
import {
  createPipelineWithDetails,
  isValidStageListing,
  type PipelineListing,
  type StageListing,
  type ValidStageListing,
} from "../api";

const PIPELINE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type NewPipelinePanelProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (pipeline: PipelineListing) => void;
  stages: StageListing[];
  initialStageIds?: string[];
};

type CompositionMode = "linear" | "dependencies";

type FieldErrors = Partial<Record<"id" | "stages", string>>;

function validateFields(values: {
  id: string;
  selectedStageIds: string[];
  compositionMode: CompositionMode;
  stageNeeds: Record<string, string>;
}): FieldErrors {
  const errors: FieldErrors = {};
  const id = values.id.trim();
  if (!id) {
    errors.id = "Id is required.";
  } else if (id.length > 64 || !PIPELINE_ID_PATTERN.test(id)) {
    errors.id = "Id must be lowercase kebab-case.";
  }
  if (values.selectedStageIds.length === 0) {
    errors.stages = "Pick at least one Stage.";
  } else if (new Set(values.selectedStageIds).size !== values.selectedStageIds.length) {
    errors.stages = "A Pipeline cannot repeat the same Stage.";
  } else if (values.compositionMode === "dependencies") {
    const selected = new Set(values.selectedStageIds);
    for (const stageId of values.selectedStageIds) {
      const needs = values.stageNeeds[stageId];
      if (needs && (!selected.has(needs) || needs === stageId)) {
        errors.stages = `Stage "${stageId}" needs a stage that is in this pipeline.`;
        break;
      }
    }
  }
  return errors;
}

function pipelineCreateBanner(status: number, serverError?: string): string {
  const detail = serverError?.trim();
  let base: string;
  if (status === 409) {
    base = "Could not create Pipeline: this id already exists.";
  } else if (status === 422) {
    const lower = detail?.toLowerCase() ?? "";
    if (lower.includes("cycle")) {
      base = "Could not create Pipeline: dependency cycle detected.";
    } else if (lower.includes("unknown needs")) {
      base =
        "Could not create Pipeline: a stage needs another stage that is not in this pipeline.";
    } else if (lower.includes("duplicate")) {
      base = "Could not create Pipeline: the same Stage was selected more than once.";
    } else if (lower.includes("no longer exist") || lower.includes("exist")) {
      base = "Could not create Pipeline: one or more selected Stages no longer exist.";
    } else {
      base = "Could not create Pipeline. Try again.";
    }
  } else {
    base = "Could not create Pipeline. Try again.";
  }
  return detail ? `${base} ${detail}` : base;
}

function gateLabel(kinds: string[] | undefined): string {
  if (!kinds || kinds.length === 0) return "none";
  return kinds.join(" · ");
}

function usageLabel(stage: ValidStageListing): string {
  const count = stage.used_by_pipeline_ids.length;
  if (count === 0) return "unused";
  return count === 1 ? "1 pipeline" : `${count} pipelines`;
}

function validStageIds(stages: StageListing[]): Set<string> {
  const ids = new Set<string>();
  for (const stage of stages) {
    if (isValidStageListing(stage)) ids.add(stage.id);
  }
  return ids;
}

function chainNeedsFromOrder(stageIds: string[]): Record<string, string> {
  const needs: Record<string, string> = {};
  for (let i = 1; i < stageIds.length; i++) {
    needs[stageIds[i]] = stageIds[i - 1];
  }
  return needs;
}

export function NewPipelinePanel({
  isOpen,
  onClose,
  onCreated,
  stages,
  initialStageIds,
}: NewPipelinePanelProps) {
  const [id, setId] = useState("");
  const [selectedStageIds, setSelectedStageIds] = useState<string[]>([]);
  const [compositionMode, setCompositionMode] = useState<CompositionMode>("linear");
  const [stageNeeds, setStageNeeds] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formBanner, setFormBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      const allowed = validStageIds(stages);
      setId("");
      setSelectedStageIds(
        (initialStageIds ?? []).filter((stageId) => allowed.has(stageId)),
      );
      setCompositionMode("linear");
      setStageNeeds({});
      setFieldErrors({});
      setFormBanner(null);
    }
    wasOpen.current = isOpen;
  }, [isOpen, initialStageIds, stages]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  function switchCompositionMode(mode: CompositionMode) {
    if (mode === compositionMode) return;
    if (mode === "dependencies") {
      setStageNeeds(chainNeedsFromOrder(selectedStageIds));
    } else {
      setStageNeeds({});
    }
    setCompositionMode(mode);
  }

  function addStage(stageId: string) {
    setSelectedStageIds((prev) =>
      prev.includes(stageId) ? prev : [...prev, stageId],
    );
  }

  function moveStage(index: number, direction: -1 | 1) {
    setSelectedStageIds((prev) => {
      const next = index + direction;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(next, 0, item);
      if (compositionMode === "dependencies") {
        setStageNeeds(chainNeedsFromOrder(copy));
      }
      return copy;
    });
  }

  function removeStage(index: number) {
    const removedId = selectedStageIds[index];
    setSelectedStageIds((prev) => prev.filter((_, i) => i !== index));
    setStageNeeds((prev) => {
      const next = { ...prev };
      delete next[removedId];
      for (const [stageId, needs] of Object.entries(next)) {
        if (needs === removedId) delete next[stageId];
      }
      return next;
    });
  }

  function setNeedsForStage(stageId: string, needs: string) {
    setStageNeeds((prev) => {
      const next = { ...prev };
      if (!needs) {
        delete next[stageId];
      } else {
        next[stageId] = needs;
      }
      return next;
    });
  }

  async function onSubmit() {
    const trimmedId = id.trim();
    const errors = validateFields({
      id: trimmedId,
      selectedStageIds,
      compositionMode,
      stageNeeds,
    });
    setFieldErrors(errors);
    setFormBanner(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    const stagesPayload =
      compositionMode === "linear"
        ? selectedStageIds
        : selectedStageIds.map((stageId) => {
            const needs = stageNeeds[stageId];
            return needs ? { id: stageId, needs } : { id: stageId };
          });
    const result = await createPipelineWithDetails({
      id: trimmedId,
      stages: stagesPayload,
    });
    setSubmitting(false);
    if (result.ok) {
      onCreated(result.pipeline);
      return;
    }
    setFormBanner(pipelineCreateBanner(result.status, result.error));
  }

  function handleClose() {
    setId("");
    setSelectedStageIds([]);
    setCompositionMode("linear");
    setStageNeeds({});
    setFieldErrors({});
    setFormBanner(null);
    onClose();
  }

  if (!isOpen) return null;

  const selectedSet = new Set(selectedStageIds);

  return (
    <>
      <button
        type="button"
        className="drawer-scrim"
        aria-label="Close panel"
        onClick={handleClose}
      />
      <aside className="drawer drawer--right" aria-labelledby="new-pipeline-title">
        <div className="drawer__head">
          <h2 id="new-pipeline-title" style={{ margin: 0, fontSize: "var(--font-size-lg)" }}>
            New pipeline
          </h2>
          <span style={{ marginLeft: "auto" }} />
          <button type="button" className="btn btn--sm" onClick={handleClose}>
            Close
          </button>
        </div>
        <div className="drawer__body">
          {formBanner ? (
            <div
              className="gate"
              style={{
                padding: "var(--spacing-4)",
                marginBottom: "var(--spacing-5)",
                borderColor: "var(--color-border-red)",
                borderLeftColor: "var(--color-error)",
                background: "var(--color-background-red)",
                color: "var(--color-text-red)",
              }}
            >
              <p className="gate__question" style={{ color: "var(--color-text-primary)", margin: 0 }}>
                {formBanner}
              </p>
            </div>
          ) : null}

          <div className="form-field">
            <label htmlFor="new-pipeline-id">Id</label>
            <input
              id="new-pipeline-id"
              className="input"
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {fieldErrors.id ? (
              <p className="field-error">{fieldErrors.id}</p>
            ) : null}
          </div>

          <div className="filters" style={{ marginTop: "var(--spacing-2)" }}>
            <button
              type="button"
              className="tab"
              data-active={compositionMode === "linear" ? "true" : undefined}
              onClick={() => switchCompositionMode("linear")}
            >
              Linear
            </button>
            <button
              type="button"
              className="tab"
              data-active={compositionMode === "dependencies" ? "true" : undefined}
              onClick={() => switchCompositionMode("dependencies")}
            >
              Dependencies
            </button>
          </div>

          <div className="form-field">
            <span className="eyebrow">Selected stages</span>
            <p
              className="muted"
              style={{ fontSize: "var(--font-size-sm)", margin: "var(--spacing-1) 0 var(--spacing-3)" }}
            >
              {compositionMode === "linear"
                ? "Order matters. Stages run top to bottom."
                : "Set which stage each row must wait for. Stages with the same needs can run in parallel."}
            </p>
            {selectedStageIds.length === 0 ? (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
                No stages selected yet.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {selectedStageIds.map((stageId, index) => (
                  <li
                    key={`${stageId}-${index}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-2)",
                      padding: "var(--spacing-2) 0",
                      borderBottom: "1px solid var(--color-border)",
                    }}
                  >
                    <span className="mono" style={{ flex: compositionMode === "dependencies" ? undefined : 1 }}>
                      {index + 1}. {stageId}
                    </span>
                    {compositionMode === "dependencies" ? (
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--spacing-2)",
                          flex: 1,
                          fontSize: "var(--font-size-sm)",
                        }}
                      >
                        <span className="muted">Needs</span>
                        <select
                          className="input"
                          value={stageNeeds[stageId] ?? ""}
                          onChange={(e) => setNeedsForStage(stageId, e.target.value)}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          <option value="">(none — root)</option>
                          {selectedStageIds
                            .filter((id) => id !== stageId)
                            .map((optionId) => (
                              <option key={optionId} value={optionId}>
                                {optionId}
                              </option>
                            ))}
                        </select>
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={index === 0}
                      onClick={() => moveStage(index, -1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={index === selectedStageIds.length - 1}
                      onClick={() => moveStage(index, 1)}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => removeStage(index)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fieldErrors.stages ? (
              <p className="field-error">{fieldErrors.stages}</p>
            ) : null}
          </div>

          <div className="form-field">
            <span className="eyebrow">Stage library</span>
            <p className="muted" style={{ fontSize: "var(--font-size-sm)", margin: "var(--spacing-1) 0 var(--spacing-3)" }}>
              Add stages from the catalog. Broken files are shown for diagnosis but cannot be selected.
            </p>
            {stages.length === 0 ? (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
                No stages in the catalog yet.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {stages.map((stage) => {
                  if (!isValidStageListing(stage)) {
                    return (
                      <li
                        key={stage.path}
                        style={{
                          padding: "var(--spacing-3)",
                          marginBottom: "var(--spacing-2)",
                          border: "1px solid var(--color-border)",
                          borderRadius: "var(--radius-container)",
                          opacity: 0.7,
                        }}
                        aria-disabled="true"
                      >
                        <span className="mono">{stage.id ?? stage.path}</span>
                        <span className="field-error" style={{ display: "block", marginTop: "var(--spacing-1)" }}>
                          {stage.error}
                        </span>
                      </li>
                    );
                  }
                  const added = selectedSet.has(stage.id);
                  return (
                    <li
                      key={stage.path}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--spacing-3)",
                        padding: "var(--spacing-3)",
                        marginBottom: "var(--spacing-2)",
                        border: "1px solid var(--color-border)",
                        borderRadius: "var(--radius-container)",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="mono">{stage.id}</span>
                        <span
                          className="muted"
                          style={{ display: "block", fontSize: "var(--font-size-xs)", marginTop: "var(--spacing-1)" }}
                        >
                          gate: {gateLabel(stage.gate_kinds)} · {usageLabel(stage)}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={added}
                        onClick={() => addStage(stage.id)}
                      >
                        {added ? "Added" : "Add"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={submitting}
              onClick={() => void onSubmit()}
            >
              {submitting ? "Creating…" : "Create pipeline"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={handleClose}>
              Cancel
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
