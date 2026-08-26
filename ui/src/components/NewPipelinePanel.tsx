import { useEffect, useRef, useState } from "react";
import {
  createPipelineWithDetails,
  type PipelineListing,
} from "../api";

const PIPELINE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const STAGE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type NewPipelinePanelProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (pipeline: PipelineListing) => void;
  pipelines: PipelineListing[];
};

type CompositionMode = "linear" | "dependencies";

type FieldErrors = Partial<Record<"directory" | "id" | "stages", string>>;

function validateFields(values: {
  directory: string;
  id: string;
  selectedStageIds: string[];
  compositionMode: CompositionMode;
  stageNeeds: Record<string, string>;
}): FieldErrors {
  const errors: FieldErrors = {};
  const directory = values.directory.trim();
  if (!directory) {
    errors.directory = "Directory is required.";
  }
  const id = values.id.trim();
  if (!id) {
    errors.id = "Id is required.";
  } else if (id.length > 64 || !PIPELINE_ID_PATTERN.test(id)) {
    errors.id = "Id must be lowercase kebab-case.";
  }
  if (values.selectedStageIds.length === 0) {
    errors.stages = "Add at least one stage id.";
  } else if (new Set(values.selectedStageIds).size !== values.selectedStageIds.length) {
    errors.stages = "A pipeline cannot repeat the same stage id.";
  } else {
    for (const stageId of values.selectedStageIds) {
      if (!STAGE_ID_PATTERN.test(stageId)) {
        errors.stages = `Stage id "${stageId}" must be lowercase kebab-case.`;
        break;
      }
    }
    if (!errors.stages && values.compositionMode === "dependencies") {
      const selected = new Set(values.selectedStageIds);
      for (const stageId of values.selectedStageIds) {
        const needs = values.stageNeeds[stageId];
        if (needs && (!selected.has(needs) || needs === stageId)) {
          errors.stages = `Stage "${stageId}" needs a stage that is in this pipeline.`;
          break;
        }
      }
    }
  }
  return errors;
}

function pipelineCreateBanner(status: number, serverError?: string): string {
  const detail = serverError?.trim();
  let base: string;
  if (status === 409) {
    base = "Could not create pipeline: this id already exists.";
  } else if (status === 422) {
    const lower = detail?.toLowerCase() ?? "";
    if (lower.includes("cycle")) {
      base = "Could not create pipeline: dependency cycle detected.";
    } else if (lower.includes("unknown needs")) {
      base =
        "Could not create pipeline: a stage needs another stage that is not in this pipeline.";
    } else if (lower.includes("duplicate")) {
      base = "Could not create pipeline: the same stage was listed more than once.";
    } else if (lower.includes("missing stage file")) {
      base =
        "Could not create pipeline: create stage files beside the pipeline directory first.";
    } else {
      base = "Could not create pipeline. Try again.";
    }
  } else {
    base = "Could not create pipeline. Try again.";
  }
  return detail ? `${base} ${detail}` : base;
}

function chainNeedsFromOrder(stageIds: string[]): Record<string, string> {
  const needs: Record<string, string> = {};
  for (let i = 1; i < stageIds.length; i++) {
    needs[stageIds[i]] = stageIds[i - 1];
  }
  return needs;
}

function catalogDirectories(pipelines: PipelineListing[]): string[] {
  const dirs = new Set<string>();
  for (const pipeline of pipelines) {
    const normalized = pipeline.path.replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    dirs.add(slash >= 0 ? normalized.slice(0, slash) : "pipelines");
  }
  if (dirs.size === 0) dirs.add("pipelines");
  return [...dirs].sort();
}

export function NewPipelinePanel({
  isOpen,
  onClose,
  onCreated,
  pipelines,
}: NewPipelinePanelProps) {
  const directoryOptions = catalogDirectories(pipelines);
  const [directory, setDirectory] = useState(directoryOptions[0] ?? "pipelines");
  const [id, setId] = useState("");
  const [selectedStageIds, setSelectedStageIds] = useState<string[]>([]);
  const [newStageId, setNewStageId] = useState("");
  const [compositionMode, setCompositionMode] = useState<CompositionMode>("linear");
  const [stageNeeds, setStageNeeds] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formBanner, setFormBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setDirectory(catalogDirectories(pipelines)[0] ?? "pipelines");
      setId("");
      setSelectedStageIds([]);
      setNewStageId("");
      setCompositionMode("linear");
      setStageNeeds({});
      setFieldErrors({});
      setFormBanner(null);
    }
    wasOpen.current = isOpen;
  }, [isOpen, pipelines]);

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

  function addStageId() {
    const stageId = newStageId.trim();
    if (!stageId || selectedStageIds.includes(stageId)) return;
    setSelectedStageIds((prev) => [...prev, stageId]);
    setNewStageId("");
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
    const trimmedDirectory = directory.trim();
    const errors = validateFields({
      directory: trimmedDirectory,
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
      directory: trimmedDirectory,
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
    setNewStageId("");
    setCompositionMode("linear");
    setStageNeeds({});
    setFieldErrors({});
    setFormBanner(null);
    onClose();
  }

  if (!isOpen) return null;

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
            <label htmlFor="new-pipeline-directory">Directory</label>
            <input
              id="new-pipeline-directory"
              className="input"
              list="pipeline-directory-options"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="pipeline-directory-options">
              {directoryOptions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            {fieldErrors.directory ? (
              <p className="field-error">{fieldErrors.directory}</p>
            ) : (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
                Repo-relative folder for <span className="mono">{id.trim() || "id"}.pipeline.yaml</span> and stage files.
              </p>
            )}
          </div>

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
            <span className="eyebrow">Stage ids</span>
            <p
              className="muted"
              style={{ fontSize: "var(--font-size-sm)", margin: "var(--spacing-1) 0 var(--spacing-3)" }}
            >
              Each id maps to <span className="mono">./&lt;id&gt;.yaml</span> beside the pipeline file. Create stage files first.
            </p>
            <div style={{ display: "flex", gap: "var(--spacing-2)", marginBottom: "var(--spacing-3)" }}>
              <input
                className="input"
                value={newStageId}
                onChange={(e) => setNewStageId(e.target.value)}
                placeholder="stage-id"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addStageId();
                  }
                }}
              />
              <button type="button" className="btn btn--sm" onClick={addStageId}>
                Add
              </button>
            </div>
            {selectedStageIds.length === 0 ? (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
                No stages added yet.
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
                            .filter((optionId) => optionId !== stageId)
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
