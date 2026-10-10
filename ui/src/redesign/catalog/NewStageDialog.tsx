import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { LuX } from "react-icons/lu";
import {
  createStageWithDetails,
  fetchPipelines,
  type CreateStageInput,
  type StageGateKind,
} from "../../api";
import { showToast } from "../../toast";
import {
  GATE_KIND_OPTIONS,
  newStageFormFrom,
  pipelineDirectoryOptions,
  validateNewStage,
  type NewStageErrors,
  type NewStageForm,
  type NewStageInitial,
  type PipelineDirectoryOption,
} from "./catalogStageModel";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const FIELD_LABEL = "text-[#a7aab2] font-sans text-xs leading-normal";
const INPUT =
  "h-8 w-full rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 text-xs text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73]";
const ERROR_TEXT = "text-[11px] text-[#f2645a]";

export type NewStageDialogProps = {
  open: boolean;
  initial?: NewStageInitial | null;
  onClose: () => void;
};

export function NewStageDialog({ open, initial, onClose }: NewStageDialogProps) {
  const [options, setOptions] = useState<PipelineDirectoryOption[]>([]);
  const [form, setForm] = useState<NewStageForm>(() => newStageFormFrom(initial));
  const [errors, setErrors] = useState<NewStageErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(newStageFormFrom(initial));
    setErrors({});
    setBanner(null);
    let cancelled = false;
    fetchPipelines()
      .then(({ pipelines }) => {
        if (cancelled) return;
        const next = pipelineDirectoryOptions(pipelines);
        setOptions(next);
        setForm((prev) =>
          prev.directoryKey && next.some((o) => o.key === prev.directoryKey)
            ? prev
            : { ...prev, directoryKey: next[0]?.key ?? "" },
        );
      })
      .catch((err) => {
        if (!cancelled) setBanner(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const selectedOption = useMemo(
    () => options.find((o) => o.key === form.directoryKey) ?? null,
    [options, form.directoryKey],
  );

  if (!open) return null;

  function setId(id: string) {
    setForm((prev) => ({
      ...prev,
      id,
      filename: prev.filenameTouched ? prev.filename : id ? `${id}.yaml` : "",
    }));
  }

  function toggleGate(kind: StageGateKind) {
    setForm((prev) => ({
      ...prev,
      gateKinds: prev.gateKinds.includes(kind)
        ? prev.gateKinds.filter((k) => k !== kind)
        : [...prev.gateKinds, kind],
    }));
  }

  async function submit() {
    const nextErrors = validateNewStage(form);
    setErrors(nextErrors);
    setBanner(null);
    if (Object.keys(nextErrors).length > 0 || !selectedOption) return;
    setSubmitting(true);
    const body: CreateStageInput & { project_root?: string } = {
      pipeline_directory: selectedOption.directory,
      filename: form.filename.trim(),
      id: form.id.trim(),
      system_prompt: form.systemPrompt,
      ...(form.model.trim() ? { model: form.model.trim() } : {}),
      ...(form.gateKinds.length > 0 ? { gate_kinds: form.gateKinds } : {}),
      ...(selectedOption.project_root ? { project_root: selectedOption.project_root } : {}),
    };
    const result = await createStageWithDetails(body);
    setSubmitting(false);
    if (!result.ok) {
      setBanner(result.error);
      return;
    }
    showToast(`Stage file written · ${result.stage.path}`);
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#040506a8] p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-y-auto rounded-xl border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-stage-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-full items-start gap-3 px-5 pb-2.5 pt-3.5">
          <div className="flex flex-1 flex-col gap-[3px]">
            <h2
              id="new-stage-title"
              className="text-lg font-semibold tracking-[-0.36px] text-[#ecedee]"
            >
              New stage
            </h2>
            <p className="text-[13px] text-[#a7aab2]">
              Writes a stage YAML file. It appears in this list once a pipeline{" "}
              <span className={`text-[#ecedee] ${MONO} text-xs`}>uses</span> it.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#1a1c21]"
          >
            <LuX className="size-4" aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-3.5 px-5 py-3">
          <label className="flex flex-col gap-[5px]">
            <span className={FIELD_LABEL}>Pipeline directory</span>
            <select
              className={`${INPUT} ${MONO}`}
              value={form.directoryKey}
              onChange={(e) => setForm((prev) => ({ ...prev, directoryKey: e.target.value }))}
            >
              {options.length === 0 ? <option value="">No pipelines found</option> : null}
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.project_root ? `${o.directory} · ${o.project_root}` : o.directory}
                </option>
              ))}
            </select>
            {errors.directory ? <p className={ERROR_TEXT}>{errors.directory}</p> : null}
          </label>
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-[5px]">
              <span className={FIELD_LABEL}>Stage id</span>
              <input
                className={`${INPUT} ${MONO}`}
                value={form.id}
                onChange={(e) => setId(e.target.value)}
                placeholder="review"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              {errors.id ? <p className={ERROR_TEXT}>{errors.id}</p> : null}
            </label>
            <label className="flex flex-1 flex-col gap-[5px]">
              <span className={FIELD_LABEL}>Filename</span>
              <input
                className={`${INPUT} ${MONO}`}
                value={form.filename}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    filename: e.target.value,
                    filenameTouched: true,
                  }))
                }
                placeholder="review.yaml"
                autoComplete="off"
                spellCheck={false}
              />
              {errors.filename ? <p className={ERROR_TEXT}>{errors.filename}</p> : null}
            </label>
          </div>
          <label className="flex flex-col gap-[5px]">
            <span className={FIELD_LABEL}>System prompt</span>
            <textarea
              className={`min-h-[120px] w-full rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2 text-xs leading-[1.55] text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73] ${MONO}`}
              value={form.systemPrompt}
              onChange={(e) => setForm((prev) => ({ ...prev, systemPrompt: e.target.value }))}
              placeholder="You are…"
              spellCheck={false}
            />
            {errors.systemPrompt ? <p className={ERROR_TEXT}>{errors.systemPrompt}</p> : null}
          </label>
          <label className="flex flex-col gap-[5px]">
            <span className={FIELD_LABEL}>Model (optional)</span>
            <input
              className={`${INPUT} ${MONO}`}
              value={form.model}
              onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
              placeholder="provider/model"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="flex flex-col gap-[5px]">
            <span className={FIELD_LABEL}>Gate kinds</span>
            <div className="flex flex-wrap gap-1.5">
              {GATE_KIND_OPTIONS.map((kind) => {
                const on = form.gateKinds.includes(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleGate(kind)}
                    className={`h-[26px] rounded-md border px-2 ${MONO} text-[11px] ${
                      on
                        ? "border-[#ecedee73] bg-[#1a1c21] text-[#ecedee]"
                        : "border-[#ffffff1a] text-[#8b8f98] hover:text-[#a7aab2]"
                    }`}
                  >
                    {kind}
                  </button>
                );
              })}
            </div>
          </div>
          {banner ? <p className={ERROR_TEXT}>{banner}</p> : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-t-[#ffffff12] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="flex h-8 items-center rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f] disabled:opacity-50"
          >
            {submitting ? "Writing…" : "Create stage"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
