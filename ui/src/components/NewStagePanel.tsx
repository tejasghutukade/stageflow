import { useEffect, useState } from "react";
import { ModelPicker } from "./ModelPicker";
import {
  createStageWithDetails,
  type StageGateKind,
  type CreatedStageListing,
} from "../api";
import {
  createStageGateKindsPayload,
  optionalCreateStageSkill,
  validateNewStageFields,
} from "../redesign/catalog/catalogStageModel";

export type GateKindsMode = "all" | "none" | "allowlist";

export { createStageGateKindsPayload };

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

type FieldErrors = Partial<Record<"id" | "system_prompt", string>>;

export function validateFields(values: {
  id: string;
  system_prompt: string;
}): FieldErrors {
  const shared = validateNewStageFields({
    id: values.id,
    systemPrompt: values.system_prompt,
  });
  const errors: FieldErrors = {};
  if (shared.id) errors.id = shared.id;
  if (shared.systemPrompt) errors.system_prompt = shared.systemPrompt;
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
  gateMode: "all" as GateKindsMode,
  gateKinds: [] as StageGateKind[],
  model: "",
  skill: "",
});

export function NewStagePanel({
  isOpen,
  onClose,
  onCreated,
  pipelineDirectory,
}: NewStagePanelProps) {
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formBanner, setFormBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  function toggleGateKind(kind: StageGateKind) {
    setForm((prev) => ({
      ...prev,
      gateKinds: prev.gateKinds.includes(kind)
        ? prev.gateKinds.filter((item) => item !== kind)
        : [...prev.gateKinds, kind],
    }));
  }

  async function onSubmit() {
    const model = form.model.trim();
    const payload = {
      id: form.id.trim(),
      system_prompt: form.system_prompt,
      model,
    };
    const errors = validateFields({ id: payload.id, system_prompt: payload.system_prompt });
    setFieldErrors(errors);
    setFormBanner(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    const result = await createStageWithDetails({
      pipeline_directory: pipelineDirectory,
      filename: `${form.id.trim()}.yaml`,
      id: payload.id,
      system_prompt: payload.system_prompt,
      ...(model.length > 0 ? { model } : {}),
      ...createStageGateKindsPayload(form.gateMode, form.gateKinds),
      ...optionalCreateStageSkill(form.skill),
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
            <span className="form-label">Model</span>
            <ModelPicker
              ariaLabel="Model"
              value={form.model || null}
              inheritLabel="Inherit default"
              onChange={(next) => setForm((prev) => ({ ...prev, model: next ?? "" }))}
            />
            <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
              Optional. Inherits pipeline then global default when omitted.
            </p>
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
            <label htmlFor="new-stage-skill">Skill</label>
            <input
              id="new-stage-skill"
              className="input"
              value={form.skill}
              onChange={(e) => setForm((prev) => ({ ...prev, skill: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
              Optional. Omitted when empty.
            </p>
          </div>

          <div className="form-field">
            <span className="eyebrow">HITL</span>
            <p className="muted" style={{ fontSize: "var(--font-size-sm)", margin: "var(--spacing-1) 0 var(--spacing-3)" }}>
              All kinds keeps every ask kind available. No HITL unregisters ask_operator. Allowlist restricts kinds.
            </p>
            <div className="pick">
              <label className="pick__opt">
                <input
                  type="radio"
                  name="new-stage-hitl"
                  checked={form.gateMode === "all"}
                  onChange={() => setForm((prev) => ({ ...prev, gateMode: "all" }))}
                />
                <span>
                  <strong>All kinds</strong>
                  <span className="muted"> Compatible default. Every ask kind is available.</span>
                </span>
              </label>
              <label className="pick__opt">
                <input
                  type="radio"
                  name="new-stage-hitl"
                  checked={form.gateMode === "none"}
                  onChange={() => setForm((prev) => ({ ...prev, gateMode: "none" }))}
                />
                <span>
                  <strong>No HITL</strong>
                  <span className="muted"> Writes gate_kinds: []. The stage cannot ask the operator.</span>
                </span>
              </label>
              <label className="pick__opt">
                <input
                  type="radio"
                  name="new-stage-hitl"
                  checked={form.gateMode === "allowlist"}
                  onChange={() =>
                    setForm((prev) => ({ ...prev, gateMode: "allowlist" }))
                  }
                />
                <span>
                  <strong>Allowlist</strong>
                  <span className="muted"> Only the kinds you select.</span>
                </span>
              </label>
            </div>
            {form.gateMode === "allowlist" ? (
              <div className="pick" style={{ marginTop: "var(--spacing-3)" }}>
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
            ) : null}
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
