import { useEffect, useState } from "react";
import {
  createTriggerWithDetails,
  fetchPipelines,
  fetchTasks,
  type PipelineListing,
  type TaskListing,
  type TriggerListItem,
} from "../api";

const TRIGGER_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type NewTriggerPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (trigger: TriggerListItem) => void;
};

export type TriggerKind = "manual" | "schedule" | "event";

type FieldErrors = Partial<
  Record<"directory" | "id" | "pipeline" | "task" | "cron" | "source", string>
>;

export function validateFields(values: {
  directory: string;
  id: string;
  pipeline: string;
  task: string;
  kind: TriggerKind;
  cron: string;
  source: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.directory.trim()) {
    errors.directory = "Directory is required.";
  }
  const id = values.id.trim();
  if (!id) {
    errors.id = "Id is required.";
  } else if (id.length > 64 || !TRIGGER_ID_PATTERN.test(id)) {
    errors.id = "Id must be lowercase kebab-case.";
  }
  if (!values.pipeline) {
    errors.pipeline = "Select a pipeline.";
  }
  if (!values.task) {
    errors.task = "Select a task.";
  }
  if (values.kind === "schedule" && !values.cron.trim()) {
    errors.cron = "Cron expression is required.";
  }
  if (values.kind === "event" && !values.source.trim()) {
    errors.source = "Event source is required.";
  }
  return errors;
}

export function triggerCreateBanner(status: number, serverError?: string): string {
  const detail = serverError?.trim();
  let base: string;
  if (status === 409) {
    base = "Could not create trigger: this id already exists.";
  } else if (status === 422) {
    base = "Could not create trigger: invalid reference or schedule.";
  } else if (status === 400) {
    base = "Could not create trigger: invalid input.";
  } else {
    base = "Could not create trigger. Try again.";
  }
  return detail ? `${base} ${detail}` : base;
}

function pipelineDirectoryOf(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : ".";
}

const emptyForm = () => ({
  directory: "",
  directoryTouched: false,
  id: "",
  pipeline: "",
  task: "",
  kind: "manual" as TriggerKind,
  cron: "",
  timezone: "",
  source: "",
  enabled: true,
});

export function NewTriggerPanel({ isOpen, onClose, onCreated }: NewTriggerPanelProps) {
  const [form, setForm] = useState(emptyForm);
  const [pipelines, setPipelines] = useState<PipelineListing[] | null>(null);
  const [tasks, setTasks] = useState<TaskListing[] | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formBanner, setFormBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setForm(emptyForm());
    setFieldErrors({});
    setFormBanner(null);
    setPipelines(null);
    setTasks(null);
    let cancelled = false;
    void (async () => {
      try {
        const [p, t] = await Promise.all([fetchPipelines(), fetchTasks()]);
        if (cancelled) return;
        setPipelines(p.pipelines);
        setTasks(t.tasks);
      } catch {
        if (cancelled) return;
        setPipelines([]);
        setTasks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  function onPipelineChange(pipelineId: string) {
    setForm((prev) => {
      const next = { ...prev, pipeline: pipelineId };
      if (!prev.directoryTouched && pipelines) {
        const match = pipelines.find((p) => p.id === pipelineId);
        if (match) next.directory = pipelineDirectoryOf(match.path);
      }
      return next;
    });
  }

  async function onSubmit() {
    const trimmed = {
      directory: form.directory.trim(),
      id: form.id.trim(),
      pipeline: form.pipeline,
      task: form.task,
      kind: form.kind,
      cron: form.cron.trim(),
      source: form.source.trim(),
    };
    const errors = validateFields(trimmed);
    setFieldErrors(errors);
    setFormBanner(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    const result = await createTriggerWithDetails({
      directory: trimmed.directory,
      id: trimmed.id,
      pipeline: trimmed.pipeline,
      task: trimmed.task,
      kind: trimmed.kind,
      ...(trimmed.kind === "schedule"
        ? {
            schedule: {
              cron: trimmed.cron,
              ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
            },
          }
        : {}),
      ...(trimmed.kind === "event" ? { event: { source: trimmed.source } } : {}),
      enabled: form.enabled,
    });
    setSubmitting(false);
    if (result.ok) {
      onCreated(result.trigger);
      return;
    }
    setFormBanner(triggerCreateBanner(result.status, result.error));
  }

  function handleClose() {
    setForm(emptyForm());
    setFieldErrors({});
    setFormBanner(null);
    onClose();
  }

  if (!isOpen) return null;

  const pipelinesLoading = pipelines === null;
  const tasksLoading = tasks === null;

  return (
    <>
      <button
        type="button"
        className="drawer-scrim"
        aria-label="Close panel"
        onClick={handleClose}
      />
      <aside className="drawer drawer--right" aria-labelledby="new-trigger-title">
        <div className="drawer__head">
          <h2 id="new-trigger-title" style={{ margin: 0, fontSize: "var(--font-size-lg)" }}>
            New trigger
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
            <label htmlFor="new-trigger-pipeline">Pipeline</label>
            <select
              id="new-trigger-pipeline"
              className="select"
              value={form.pipeline}
              disabled={pipelinesLoading}
              onChange={(e) => onPipelineChange(e.target.value)}
            >
              <option value="">
                {pipelinesLoading ? "Loading pipelines…" : "Select a pipeline"}
              </option>
              {(pipelines ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
            {fieldErrors.pipeline ? (
              <p className="field-error">{fieldErrors.pipeline}</p>
            ) : !pipelinesLoading && pipelines?.length === 0 ? (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
                No pipelines in the manifest yet.
              </p>
            ) : null}
          </div>

          <div className="form-field">
            <label htmlFor="new-trigger-task">Task</label>
            <select
              id="new-trigger-task"
              className="select"
              value={form.task}
              disabled={tasksLoading}
              onChange={(e) => setForm((prev) => ({ ...prev, task: e.target.value }))}
            >
              <option value="">
                {tasksLoading ? "Loading tasks…" : "Select a task"}
              </option>
              {(tasks ?? []).map((t) => (
                <option key={t.path} value={t.id}>
                  {t.id}
                </option>
              ))}
            </select>
            {fieldErrors.task ? (
              <p className="field-error">{fieldErrors.task}</p>
            ) : !tasksLoading && tasks?.length === 0 ? (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
                No tasks in the manifest yet.
              </p>
            ) : null}
          </div>

          <div className="form-field">
            <label htmlFor="new-trigger-directory">Directory</label>
            <input
              id="new-trigger-directory"
              className="input"
              value={form.directory}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  directory: e.target.value,
                  directoryTouched: true,
                }))
              }
              autoComplete="off"
              spellCheck={false}
            />
            {fieldErrors.directory ? (
              <p className="field-error">{fieldErrors.directory}</p>
            ) : (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
                Repo-relative folder for <span className="mono">{form.id.trim() || "id"}.trigger.yaml</span>.
              </p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="new-trigger-id">Id</label>
            <input
              id="new-trigger-id"
              className="input"
              value={form.id}
              onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
            {fieldErrors.id ? <p className="field-error">{fieldErrors.id}</p> : null}
          </div>

          <div className="form-field">
            <label htmlFor="new-trigger-kind">Kind</label>
            <select
              id="new-trigger-kind"
              className="select"
              value={form.kind}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, kind: e.target.value as TriggerKind }))
              }
            >
              <option value="manual">Manual</option>
              <option value="schedule">Schedule</option>
              <option value="event">Event</option>
            </select>
          </div>

          {form.kind === "schedule" ? (
            <>
              <div className="form-field">
                <label htmlFor="new-trigger-cron">Cron expression</label>
                <input
                  id="new-trigger-cron"
                  className="input mono"
                  value={form.cron}
                  onChange={(e) => setForm((prev) => ({ ...prev, cron: e.target.value }))}
                  placeholder="0 * * * *"
                  autoComplete="off"
                  spellCheck={false}
                />
                {fieldErrors.cron ? (
                  <p className="field-error">{fieldErrors.cron}</p>
                ) : (
                  <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
                    Validated server-side against real cron syntax.
                  </p>
                )}
              </div>
              <div className="form-field">
                <label htmlFor="new-trigger-timezone">Timezone (optional)</label>
                <input
                  id="new-trigger-timezone"
                  className="input"
                  value={form.timezone}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, timezone: e.target.value }))
                  }
                  placeholder="UTC"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </>
          ) : null}

          {form.kind === "event" ? (
            <div className="form-field">
              <label htmlFor="new-trigger-source">Event source</label>
              <input
                id="new-trigger-source"
                className="input"
                value={form.source}
                onChange={(e) => setForm((prev) => ({ ...prev, source: e.target.value }))}
                autoComplete="off"
                spellCheck={false}
              />
              {fieldErrors.source ? (
                <p className="field-error">{fieldErrors.source}</p>
              ) : (
                <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-1)" }}>
                  No event adapter reads this yet; the trigger will not fire on its own until one lands.
                </p>
              )}
            </div>
          ) : null}

          <div className="form-field">
            <label className="pick__opt" style={{ display: "flex", alignItems: "center", gap: "var(--spacing-2)" }}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, enabled: e.target.checked }))
                }
              />
              <span>Enabled</span>
            </label>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={submitting}
              onClick={() => void onSubmit()}
            >
              {submitting ? "Creating…" : "Create trigger"}
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
