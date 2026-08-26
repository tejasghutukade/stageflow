import { useEffect, useState } from "react";
import {
  createStageWithDetails,
  fetchModels,
  type StageGateKind,
  type CreatedStageListing,
} from "../api";

const STAGE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MODEL_OTHER = "__other__";

const GATE_KINDS: StageGateKind[] = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
];

export type NewStagePanelProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (stage: CreatedStageListing) => void;
  pipelineDirectory: string;
};

type FieldErrors = Partial<Record<"id" | "model" | "system_prompt", string>>;

function validateFields(values: {
  id: string;
  model: string;
  system_prompt: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  const id = values.id.trim();
  if (!id) {
    errors.id = "Id is required.";
  } else if (id.length > 64 || !STAGE_ID_PATTERN.test(id)) {
    errors.id = "Id must be lowercase kebab-case.";
  }
  if (!values.model.trim()) {
    errors.model = "Model is required.";
  }
  if (!values.system_prompt.trim()) {
    errors.system_prompt = "System prompt is required.";
  }
  return errors;
}

function stageCreateBanner(status: number, serverError?: string): string {
  const base =
    status === 409
      ? "Could not create Stage: this id already exists."
      : "Could not create Stage. Try again.";
  const detail = serverError?.trim();
  return detail ? `${base} ${detail}` : base;
}

const emptyForm = () => ({
  id: "",
  system_prompt: "",
  gateKinds: [] as StageGateKind[],
  modelSelect: "",
  customModel: "",
  plainModel: "",
});

export function NewStagePanel({
  isOpen,
  onClose,
  onCreated,
  pipelineDirectory,
}: NewStagePanelProps) {
  const [form, setForm] = useState(emptyForm);
  const [models, setModels] = useState<string[] | null>(null);
  const [useDropdown, setUseDropdown] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formBanner, setFormBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const { models: listed } = await fetchModels();
        if (cancelled) return;
        if (listed.length > 0) {
          setModels(listed);
          setUseDropdown(true);
          setForm((prev) => ({
            ...prev,
            modelSelect: prev.modelSelect || listed[0] || "",
          }));
        } else {
          setModels([]);
          setUseDropdown(false);
        }
      } catch {
        if (cancelled) return;
        setModels(null);
        setUseDropdown(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  function resolvedModel(): string {
    if (useDropdown) {
      if (form.modelSelect === MODEL_OTHER) {
        return form.customModel.trim();
      }
      return form.modelSelect.trim();
    }
    return form.plainModel.trim();
  }

  function toggleGateKind(kind: StageGateKind) {
    setForm((prev) => ({
      ...prev,
      gateKinds: prev.gateKinds.includes(kind)
        ? prev.gateKinds.filter((item) => item !== kind)
        : [...prev.gateKinds, kind],
    }));
  }

  async function onSubmit() {
    const model = resolvedModel();
    const payload = {
      id: form.id.trim(),
      system_prompt: form.system_prompt,
      model,
    };
    const errors = validateFields(payload);
    setFieldErrors(errors);
    setFormBanner(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    const result = await createStageWithDetails({
      pipeline_directory: pipelineDirectory,
      filename: `${form.id.trim()}.yaml`,
      ...payload,
      ...(form.gateKinds.length > 0 ? { gate_kinds: form.gateKinds } : {}),
    });
    setSubmitting(false);
    if (result.ok) {
      setForm(emptyForm());
      setFieldErrors({});
      setFormBanner(null);
      onCreated(result.stage);
      return;
    }
    setFormBanner(stageCreateBanner(result.status, result.error));
  }

  function handleClose() {
    setForm(emptyForm());
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
      <aside className="drawer drawer--right" aria-labelledby="new-stage-title">
        <div className="drawer__head">
          <h2 id="new-stage-title" style={{ margin: 0, fontSize: "var(--font-size-lg)" }}>
            New stage
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
            <label htmlFor="new-stage-id">Id</label>
            <input
              id="new-stage-id"
              className="input"
              value={form.id}
              onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
            {fieldErrors.id ? (
              <p className="field-error">{fieldErrors.id}</p>
            ) : (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
                Writes <span className="mono">{pipelineDirectory}/&lt;id&gt;.yaml</span>.
              </p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="new-stage-model">Model</label>
            {useDropdown && models ? (
              <>
                <select
                  id="new-stage-model"
                  className="select"
                  value={form.modelSelect}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, modelSelect: e.target.value }))
                  }
                >
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                  <option value={MODEL_OTHER}>Other...</option>
                </select>
                {form.modelSelect === MODEL_OTHER ? (
                  <input
                    className="input"
                    style={{ marginTop: "var(--spacing-2)" }}
                    value={form.customModel}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, customModel: e.target.value }))
                    }
                    placeholder="Model id"
                    autoComplete="off"
                    spellCheck={false}
                  />
                ) : null}
              </>
            ) : (
              <input
                id="new-stage-model"
                className="input"
                value={form.plainModel}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, plainModel: e.target.value }))
                }
                autoComplete="off"
                spellCheck={false}
              />
            )}
            {fieldErrors.model ? (
              <p className="field-error">{fieldErrors.model}</p>
            ) : null}
          </div>

          <div className="form-field">
            <label htmlFor="new-stage-prompt">System prompt</label>
            <textarea
              id="new-stage-prompt"
              className="textarea"
              rows={6}
              value={form.system_prompt}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, system_prompt: e.target.value }))
              }
            />
            {fieldErrors.system_prompt ? (
              <p className="field-error">{fieldErrors.system_prompt}</p>
            ) : null}
          </div>

          <div className="form-field">
            <span className="eyebrow">Gate kinds</span>
            <p className="muted" style={{ fontSize: "var(--font-size-sm)", margin: "var(--spacing-1) 0 var(--spacing-3)" }}>
              Optional. Declare which kinds of human input this stage may stop for.
            </p>
            <div className="pick">
              {GATE_KINDS.map((kind) => (
                <label key={kind} className="pick__opt">
                  <input
                    type="checkbox"
                    checked={form.gateKinds.includes(kind)}
                    onChange={() => toggleGateKind(kind)}
                  />
                  <span>
                    <strong className="mono">{kind}</strong>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={submitting}
              onClick={() => void onSubmit()}
            >
              {submitting ? "Creating…" : "Create stage"}
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
