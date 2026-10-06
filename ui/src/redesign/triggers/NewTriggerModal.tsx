import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  createTriggerWithDetails,
  fetchPipelines,
  fetchTasks,
  type PipelineListing,
  type TaskListing,
  type TriggerListItem,
} from "../../api";
import {
  type TriggerKind,
  type TaskMode,
  validateFields,
  triggerCreateBanner,
} from "../../components/NewTriggerPanel";
import { Keycap } from "../Keycap";
import { useHotkeys } from "../keys";
import { buildTriggerYamlPreview } from "./triggerYamlPreview";
import { LuClock, LuMousePointerClick, LuRadio, LuX } from "react-icons/lu";

export type NewTriggerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (trigger: TriggerListItem) => void;
};

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
  taskMode: "catalog" as TaskMode,
  kind: "manual" as TriggerKind,
  cron: "",
  timezone: "",
  source: "",
  enabled: true,
});

function SelectShell({
  loading,
  loadingLabel,
  emptyLabel,
  value,
  onChange,
  options,
}: {
  loading: boolean;
  loadingLabel: string;
  emptyLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  if (loading) {
    return (
      <div
        className="flex h-9 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 text-[13px] text-[var(--sf-text-3)]"
        aria-busy="true"
      >
        {loadingLabel}
      </div>
    );
  }
  return (
    <select
      className="flex h-9 w-full items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function NewTriggerModal({
  isOpen,
  onClose,
  onCreated,
}: NewTriggerModalProps) {
  const [form, setForm] = useState(emptyForm);
  const [pipelines, setPipelines] = useState<PipelineListing[] | null>(null);
  const [tasks, setTasks] = useState<TaskListing[] | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<string, string>>
  >({});
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

  const yamlPreview = useMemo(
    () =>
      buildTriggerYamlPreview({
        id: form.id,
        pipeline: form.pipeline,
        taskMode: form.taskMode,
        task: form.task,
        kind: form.kind,
        cron: form.cron,
        timezone: form.timezone,
        source: form.source,
        enabled: form.enabled,
      }),
    [form],
  );

  const handleClose = useCallback(() => {
    setForm(emptyForm());
    setFieldErrors({});
    setFormBanner(null);
    onClose();
  }, [onClose]);

  useHotkeys(
    [
      {
        key: "escape",
        scope: "global",
        when: () => isOpen,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          handleClose();
        },
      },
    ],
    "global",
  );

  if (!isOpen) return null;

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
      taskMode: form.taskMode,
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
      ...(trimmed.taskMode === "catalog" ? { task: trimmed.task } : {}),
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
      handleClose();
      return;
    }
    setFormBanner(triggerCreateBanner(result.status, result.error));
  }

  const pipelinesLoading = pipelines === null;
  const tasksLoading = tasks === null;

  const kindCardClass = (kind: TriggerKind) =>
    `flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border px-3 ${
      form.kind === kind
        ? "border-[#ecedee8c] bg-[var(--sf-raised)] shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]"
        : "border-[#ffffff1a] bg-[#0f1013]"
    }`;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-[#040506a8] pt-4 pl-[232px]"
      role="presentation"
      onClick={handleClose}
    >
      <div
        className="flex max-h-[calc(100vh-32px)] w-[760px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-[#ffffff1a] bg-[var(--sf-panel)] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-trigger-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 px-5 pb-2.5 pt-3.5">
          <div className="flex flex-1 flex-col gap-[3px]">
            <h2
              id="new-trigger-title"
              className="text-lg font-semibold tracking-[-0.36px] text-[var(--sf-text-1)]"
            >
              New trigger
            </h2>
            <p className="text-[13px] text-[var(--sf-text-2)]">
              Starts a pipeline on a schedule, on an event, or by hand. Saved as a{" "}
              <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]">
                .trigger.yaml
              </span>{" "}
              file.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <Keycap>esc</Keycap>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-lg text-[var(--sf-text-2)] hover:bg-[var(--sf-raised)]"
              onClick={handleClose}
              aria-label="Close"
            >
              <LuX className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
          {formBanner ? (
            <p className="mb-3 text-[12px] text-[var(--sf-fail)]" role="alert">
              {formBanner}
            </p>
          ) : null}

          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-4">
              <div className="flex flex-1 flex-col gap-1.5">
                <label
                  htmlFor="modal-trigger-id"
                  className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]"
                >
                  Id
                </label>
                <input
                  id="modal-trigger-id"
                  className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none focus:border-[#ecedee73] focus:shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]"
                  value={form.id}
                  onChange={(e) => setForm((p) => ({ ...p, id: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                />
                {fieldErrors.id ? (
                  <p className="text-[11px] text-[var(--sf-fail)]">{fieldErrors.id}</p>
                ) : null}
              </div>
              <label className="flex h-8 shrink-0 items-center gap-2.5 rounded-lg border border-[#ffffff12] bg-[#0f1013] px-2.5 text-[13px] text-[var(--sf-text-1)]">
                Enabled
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, enabled: e.target.checked }))
                  }
                />
                <span
                  className={`flex h-[18px] w-[30px] items-center rounded-full p-0.5 ${
                    form.enabled
                      ? "justify-end bg-[var(--sf-text-1)]"
                      : "justify-start bg-[var(--sf-track-empty)]"
                  }`}
                >
                  <span className="size-3.5 rounded-full bg-[var(--sf-ground)]" />
                </span>
              </label>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  When
                </span>
                <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
                  kind: {form.kind}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  className={kindCardClass("schedule")}
                  onClick={() => setForm((p) => ({ ...p, kind: "schedule" }))}
                >
                  <LuClock className="size-[15px] shrink-0 text-[var(--sf-text-3)]" aria-hidden />
                  <span className="text-[13px] font-medium text-[var(--sf-text-1)]">
                    Schedule
                  </span>
                </button>
                <button
                  type="button"
                  className={kindCardClass("event")}
                  onClick={() => setForm((p) => ({ ...p, kind: "event" }))}
                >
                  <LuRadio className="size-[15px] shrink-0 text-[var(--sf-text-3)]" aria-hidden />
                  <span className="text-[13px] font-medium text-[var(--sf-text-1)]">
                    Event
                  </span>
                </button>
                <button
                  type="button"
                  className={kindCardClass("manual")}
                  onClick={() => setForm((p) => ({ ...p, kind: "manual" }))}
                >
                  <LuMousePointerClick
                    className="size-[15px] shrink-0 text-[var(--sf-text-3)]"
                    aria-hidden
                  />
                  <span className="text-[13px] font-medium text-[var(--sf-text-1)]">
                    Manual
                  </span>
                </button>
              </div>
            </div>

            {form.kind === "schedule" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="modal-trigger-cron"
                    className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]"
                  >
                    Cron
                  </label>
                  <input
                    id="modal-trigger-cron"
                    className="h-9 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)] outline-none"
                    value={form.cron}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, cron: e.target.value }))
                    }
                    placeholder="0 2 * * *"
                  />
                  {fieldErrors.cron ? (
                    <p className="text-[11px] text-[var(--sf-fail)]">{fieldErrors.cron}</p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="modal-trigger-tz"
                    className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]"
                  >
                    Timezone
                  </label>
                  <input
                    id="modal-trigger-tz"
                    className="h-9 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 text-[13px] text-[var(--sf-text-1)] outline-none"
                    value={form.timezone}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, timezone: e.target.value }))
                    }
                    placeholder="UTC"
                  />
                </div>
              </div>
            ) : null}

            {form.kind === "event" ? (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="modal-trigger-source"
                  className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]"
                >
                  Event source
                </label>
                <input
                  id="modal-trigger-source"
                  className="h-9 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 text-[13px] text-[var(--sf-text-1)] outline-none"
                  value={form.source}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, source: e.target.value }))
                  }
                />
                {fieldErrors.source ? (
                  <p className="text-[11px] text-[var(--sf-fail)]">{fieldErrors.source}</p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                Then run
              </span>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-[var(--sf-text-3)]">Pipeline</span>
                  <SelectShell
                    loading={pipelinesLoading}
                    loadingLabel="Loading pipelines…"
                    emptyLabel="Select a pipeline"
                    value={form.pipeline}
                    onChange={onPipelineChange}
                    options={(pipelines ?? []).map((p) => ({
                      value: p.id,
                      label: p.id,
                    }))}
                  />
                  {fieldErrors.pipeline ? (
                    <p className="text-[11px] text-[var(--sf-fail)]">
                      {fieldErrors.pipeline}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-[var(--sf-text-3)]">Task</span>
                  {form.taskMode === "catalog" ? (
                    <SelectShell
                      loading={tasksLoading}
                      loadingLabel="Loading tasks…"
                      emptyLabel="Select a task"
                      value={form.task}
                      onChange={(task) => setForm((p) => ({ ...p, task }))}
                      options={(tasks ?? []).map((t) => ({
                        value: t.id,
                        label: t.id,
                      }))}
                    />
                  ) : (
                    <div className="flex h-9 items-center rounded-lg border border-[#ffffff1a] bg-[#0f1013] px-2.5 text-[13px] text-[var(--sf-text-2)]">
                      Dynamic at fire time
                    </div>
                  )}
                  {fieldErrors.task ? (
                    <p className="text-[11px] text-[var(--sf-fail)]">{fieldErrors.task}</p>
                  ) : null}
                </div>
              </div>
              <div className="flex gap-4 text-[12px] text-[var(--sf-text-2)]">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={form.taskMode === "catalog"}
                    onChange={() =>
                      setForm((p) => ({ ...p, taskMode: "catalog" }))
                    }
                  />
                  Catalog task
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={form.taskMode === "dynamic"}
                    onChange={() =>
                      setForm((p) => ({ ...p, taskMode: "dynamic" }))
                    }
                  />
                  Dynamic at fire time
                </label>
              </div>
              {fieldErrors.directory ? (
                <p className="text-[11px] text-[var(--sf-fail)]">{fieldErrors.directory}</p>
              ) : null}
            </div>

            <div className="rounded-lg border border-[#ffffff12] bg-[#0f1013] p-3">
              <div className="mb-2 text-xs font-medium text-[var(--sf-text-1)]">
                YAML preview
              </div>
              <pre className="m-0 whitespace-pre-wrap font-['Geist_Mono',monospace] text-xs leading-[1.333] text-[var(--sf-text-2)]">
                {yamlPreview}
              </pre>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-t-[#ffffff12] px-5 py-3">
          <button
            type="button"
            className="sf-btn sf-btn--ghost"
            onClick={handleClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sf-btn sf-btn--primary"
            disabled={submitting || pipelinesLoading || tasksLoading}
            onClick={() => void onSubmit()}
          >
            {submitting ? "Creating…" : "Create trigger"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
