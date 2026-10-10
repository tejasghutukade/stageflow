import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LuX } from "react-icons/lu";
import {
  createTaskWithDetails,
  importTaskFromIssue,
  updateTask,
  type TaskDetailFile,
} from "../../api";

export type TaskFormMode = "create" | "edit" | "duplicate" | "import";

export type TaskFormInitial = {
  directory?: string;
  id?: string;
  goal?: string;
  context?: string;
  constraints?: string;
  checkout?: string;
  repository?: string;
  ref?: string;
  project_root?: string;
};

type TaskFormState = {
  directory: string;
  id: string;
  goal: string;
  context: string;
  constraints: string;
  checkout: string;
  repository: string;
  ref: string;
  repo: string;
  number: string;
};

const MONO = "[font-family:'Geist_Mono',_monospace]";
const FIELD_LABEL = "text-[#a7aab2] font-sans text-xs leading-normal";
const INPUT =
  "h-8 w-full rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 text-xs text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73] read-only:text-[#8b8f98]";
const TEXTAREA =
  "min-h-[72px] w-full rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2 text-xs leading-[1.55] text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73]";
const ERROR_TEXT = "text-[11px] text-[#f2645a]";

const TITLES: Record<TaskFormMode, string> = {
  create: "New task",
  duplicate: "Duplicate task",
  edit: "Edit task",
  import: "Import from issue",
};

const SUBMIT_LABELS: Record<TaskFormMode, string> = {
  create: "Create task",
  duplicate: "Create task",
  edit: "Save task",
  import: "Import task",
};

function formFrom(initial: TaskFormInitial | null | undefined): TaskFormState {
  return {
    directory: initial?.directory ?? "examples",
    id: initial?.id ?? "",
    goal: initial?.goal ?? "",
    context: initial?.context ?? "",
    constraints: initial?.constraints ?? "",
    checkout: initial?.checkout ?? "",
    repository: initial?.repository ?? "",
    ref: initial?.ref ?? "",
    repo: "",
    number: "",
  };
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function validate(mode: TaskFormMode, form: TaskFormState): string | null {
  if (!form.directory.trim()) return "Directory is required.";
  if (mode === "import") {
    if (!/^[^/\s]+\/[^/\s]+$/.test(form.repo.trim())) return "Repository must be owner/name.";
    if (!/^\d+$/.test(form.number.trim()) || Number(form.number) <= 0) {
      return "Issue number must be a positive integer.";
    }
    return null;
  }
  if (!form.id.trim()) return "Task id is required.";
  if (!form.goal.trim()) return "Goal is required.";
  if (form.checkout.trim() && form.repository.trim()) {
    return "Set checkout or repository, not both.";
  }
  return null;
}

export type TaskFormDialogProps = {
  open: boolean;
  mode: TaskFormMode;
  initial?: TaskFormInitial | null;
  onClose: () => void;
  onSaved: (task: TaskDetailFile, projectRoot?: string) => void;
};

export function TaskFormDialog({ open, mode, initial, onClose, onSaved }: TaskFormDialogProps) {
  const [form, setForm] = useState<TaskFormState>(() => formFrom(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(formFrom(initial));
    setError(null);
    setSubmitting(false);
  }, [open, initial, mode]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isEdit = mode === "edit";
  const isImport = mode === "import";
  const projectRoot = initial?.project_root;

  function set<K extends keyof TaskFormState>(key: K, value: TaskFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    const problem = validate(mode, form);
    setError(problem);
    if (problem) return;
    setSubmitting(true);
    const rootPart = projectRoot ? { project_root: projectRoot } : {};
    const fields = {
      goal: form.goal.trim(),
      context: optional(form.context),
      constraints: optional(form.constraints),
      checkout: optional(form.checkout),
      repository: optional(form.repository),
      ref: optional(form.ref),
    };
    const result = isImport
      ? await importTaskFromIssue({
          repo: form.repo.trim(),
          number: Number(form.number.trim()),
          directory: form.directory.trim(),
          ...rootPart,
        })
      : isEdit
        ? await updateTask(form.id.trim(), fields)
        : await createTaskWithDetails({
            directory: form.directory.trim(),
            id: form.id.trim(),
            ...fields,
            ...rootPart,
          });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.task, projectRoot);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#040506a8] p-4"
      role="presentation"
      onClick={onClose}
    >
      <form
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-y-auto rounded-xl border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-form-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex w-full items-start gap-3 px-5 pb-2.5 pt-3.5">
          <div className="flex flex-1 flex-col gap-[3px]">
            <h2
              id="task-form-title"
              className="text-lg font-semibold tracking-[-0.36px] text-[#ecedee]"
            >
              {TITLES[mode]}
            </h2>
            <p className="text-[13px] text-[#a7aab2]">
              {isImport
                ? "Reads a public GitHub issue, or a private one if GITHUB_TOKEN is set on the host."
                : isEdit
                  ? "Rewrites this task YAML file."
                  : "Writes a task YAML file into the catalog."}
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
          {isImport ? (
            <div className="flex gap-3">
              <label className="flex flex-[2] flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Repository</span>
                <input
                  className={`${INPUT} ${MONO}`}
                  value={form.repo}
                  onChange={(e) => set("repo", e.target.value)}
                  placeholder="owner/name"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </label>
              <label className="flex flex-1 flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Issue number</span>
                <input
                  className={`${INPUT} ${MONO}`}
                  value={form.number}
                  onChange={(e) => set("number", e.target.value)}
                  placeholder="123"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </label>
            </div>
          ) : null}
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-[5px]">
              <span className={FIELD_LABEL}>Directory</span>
              <input
                className={`${INPUT} ${MONO}`}
                value={form.directory}
                onChange={(e) => set("directory", e.target.value)}
                placeholder="examples"
                readOnly={isEdit}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {isImport ? null : (
              <label className="flex flex-1 flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Task id</span>
                <input
                  className={`${INPUT} ${MONO}`}
                  value={form.id}
                  onChange={(e) => set("id", e.target.value)}
                  placeholder="fix-login-redirect"
                  readOnly={isEdit}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={!isEdit}
                />
              </label>
            )}
          </div>
          <p className="text-[11px] leading-normal text-[#8b8f98]">
            {initial?.project_root
              ? `Project: ${initial.project_root.split(/[/\\]/).filter(Boolean).at(-1)}`
              : "Project: this host"}
          </p>
          {isImport ? null : (
            <>
              <label className="flex flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Goal</span>
                <input
                  className={INPUT}
                  value={form.goal}
                  onChange={(e) => set("goal", e.target.value)}
                  placeholder="What should this task accomplish?"
                  autoFocus={isEdit}
                />
              </label>
              <label className="flex flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Context (optional)</span>
                <textarea
                  className={TEXTAREA}
                  value={form.context}
                  onChange={(e) => set("context", e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Constraints (optional, one per line)</span>
                <textarea
                  className={`${TEXTAREA} ${MONO}`}
                  value={form.constraints}
                  onChange={(e) => set("constraints", e.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-[5px]">
                  <span className={FIELD_LABEL}>Checkout</span>
                  <input
                    className={`${INPUT} ${MONO}`}
                    value={form.checkout}
                    onChange={(e) => set("checkout", e.target.value)}
                    placeholder="../path/to/repo"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="flex flex-1 flex-col gap-[5px]">
                  <span className={FIELD_LABEL}>Repository</span>
                  <input
                    className={`${INPUT} ${MONO}`}
                    value={form.repository}
                    onChange={(e) => set("repository", e.target.value)}
                    placeholder="https://github.com/owner/name"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="flex w-[120px] shrink-0 flex-col gap-[5px]">
                  <span className={FIELD_LABEL}>Ref</span>
                  <input
                    className={`${INPUT} ${MONO}`}
                    value={form.ref}
                    onChange={(e) => set("ref", e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
              <p className="text-[11px] text-[#8b8f98]">
                Checkout and repository cannot both be set.
              </p>
            </>
          )}
          {error ? <p className={ERROR_TEXT}>{error}</p> : null}
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
            type="submit"
            disabled={submitting}
            className="flex h-8 items-center rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f] disabled:opacity-50"
          >
            {submitting ? "Saving…" : SUBMIT_LABELS[mode]}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
