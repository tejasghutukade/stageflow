import { useState } from "react";
import type { EvalCaseInput } from "../../../api/evalTypes";
import { BTN, BTN_PRIMARY, DialogShell, INPUT, LABEL, MONO, TEXTAREA } from "./DialogShell";
import { buildAddCase, nextCaseId, validateDatasetName, type AddCaseForm } from "./datasetModel";

export function ConfirmDialog({
  title,
  body,
  confirmText,
  danger,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmText: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <DialogShell
      title={title}
      width="w-[440px]"
      onClose={onClose}
      footer={
        <>
          <span />
          <span className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button
              type="button"
              disabled={busy}
              className={danger ? `${BTN} !border-[var(--sf-fail)] !text-[var(--sf-fail)]` : BTN_PRIMARY}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmText}
            </button>
          </span>
        </>
      }
    >
      <p className="text-[13px] leading-[1.5] text-[var(--sf-text-2)]">{body}</p>
    </DialogShell>
  );
}

export function AddCaseDialog({
  inputFields,
  jsonFields,
  existingIds,
  onClose,
  onConfirm,
}: {
  inputFields: Array<{ name: string; required: boolean }>;
  jsonFields: string[];
  existingIds: string[];
  onClose: () => void;
  onConfirm: (c: EvalCaseInput & { id: string }) => void | Promise<void>;
}) {
  const [form, setForm] = useState<AddCaseForm>({
    id: nextCaseId(existingIds),
    title: "",
    inputs: {},
    ...(inputFields.length === 0 ? { inputJson: "{}" } : {}),
    expected: "",
    tags: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const result = buildAddCase(form, { existingIds, jsonFields });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm(result.case);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const names = inputFields.length > 0 ? inputFields : [];
  return (
    <DialogShell
      title="Add case"
      subtitle="Saved to the dataset file as one new case."
      width="w-[640px]"
      onClose={onClose}
      footer={
        <>
          <span className="text-xs text-[var(--sf-fail)]" role={failure ? "alert" : undefined}>{failure}</span>
          <span className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void submit()}>Add case</button>
          </span>
        </>
      }
    >
      <Field label="id" error={errors.id}>
        <input aria-label="id" className={`${INPUT} ${MONO}`} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
      </Field>
      <Field label="title" error={errors.title}>
        <input aria-label="title" className={INPUT} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      {names.map((f) => {
        const json = jsonFields.includes(f.name);
        return (
          <Field
            key={f.name}
            label={`${f.name}${f.required ? " (required)" : ""}${json ? " (JSON)" : ""}`}
            error={errors[`input.${f.name}`]}
          >
            <textarea
              aria-label={f.name}
              rows={json ? 3 : 4}
              className={`${TEXTAREA} ${MONO}`}
              value={form.inputs[f.name] ?? ""}
              onChange={(e) => setForm({ ...form, inputs: { ...form.inputs, [f.name]: e.target.value } })}
            />
          </Field>
        );
      })}
      {form.inputJson !== undefined ? (
        <Field label="input (JSON object)" error={errors.inputJson}>
          <textarea
            aria-label="input"
            rows={5}
            className={`${TEXTAREA} ${MONO}`}
            value={form.inputJson}
            onChange={(e) => setForm({ ...form, inputJson: e.target.value })}
          />
        </Field>
      ) : null}
      <Field label="expected (JSON)" error={errors.expected}>
        <textarea
          aria-label="expected"
          rows={3}
          className={`${TEXTAREA} ${MONO}`}
          value={form.expected}
          onChange={(e) => setForm({ ...form, expected: e.target.value })}
        />
      </Field>
      <Field label="tags (space or comma separated)" error={errors.tags}>
        <input aria-label="tags" className={`${INPUT} ${MONO}`} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
      </Field>
    </DialogShell>
  );
}

function Field({ label, error, children }: { label: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--sf-text-2)]">{label}</span>
      {children}
      {error ? <span className="text-[11px] text-[var(--sf-fail)]">{error}</span> : null}
    </label>
  );
}

export function NewDatasetDialog({
  existingNames,
  onClose,
  onContinue,
}: {
  existingNames: string[];
  onClose: () => void;
  onContinue: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const error = validateDatasetName(name, existingNames);
  function go() {
    setTouched(true);
    if (!error) onContinue(name);
  }
  return (
    <DialogShell
      title="New dataset"
      subtitle="Name it, then upload or paste rows. Nothing is written until you add them."
      width="w-[480px]"
      onClose={onClose}
      footer={
        <>
          <span />
          <span className="flex items-center gap-2">
            <button type="button" className={BTN} onClick={onClose}>Cancel</button>
            <button type="button" className={BTN_PRIMARY} onClick={go}>Continue</button>
          </span>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className={LABEL}>Name</span>
        <input
          autoFocus
          aria-label="Dataset name"
          className={`${INPUT} ${MONO}`}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
          placeholder="review-diffs"
        />
        {touched && error ? <span className="text-[11px] text-[var(--sf-fail)]">{error}</span> : null}
        <span className="text-[11px] text-[var(--sf-text-3)]">Saved as datasets/{name || "<name>"}.dataset.jsonl</span>
      </label>
    </DialogShell>
  );
}
