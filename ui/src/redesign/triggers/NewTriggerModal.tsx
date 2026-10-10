import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  createTriggerWithDetails,
  fetchPipelines,
  fetchTasks,
  updateTrigger,
  type PipelineListing,
  type TaskListing,
  type TriggerListItem,
} from "../../api";
import { triggerCreateBanner } from "../../components/NewTriggerPanel";
import { useHotkeys } from "../keys";
import { nextScheduleRuns } from "./cronPreview";
import {
  GITHUB_ACTIONS,
  buildCreateTriggerBody,
  buildTriggerEvent,
  buildUpdateTriggerBody,
  describeCron,
  directoryForPipeline,
  formFromInitial,
  formatNextRun,
  timezoneOptions,
  triggerFireCommand,
  triggerYamlPath,
  validateNewTriggerForm,
  type EventSourceKind,
  type NewTriggerFieldErrors,
  type NewTriggerForm,
  type NewTriggerInitial,
  type TriggerKind,
} from "./newTriggerModel";
import { buildTriggerYamlPreview } from "./triggerYamlPreview";
import {
  LuCheck,
  LuChevronDown,
  LuCircleAlert,
  LuClock,
  LuCopy,
  LuFileCode,
  LuGithub,
  LuGlobe,
  LuInfo,
  LuKeyRound,
  LuMail,
  LuMousePointerClick,
  LuSparkles,
  LuTerminal,
  LuWebhook,
  LuWorkflow,
  LuX,
  LuZap,
} from "react-icons/lu";
import type { IconType } from "react-icons";

export type NewTriggerModalProps = {
  open?: boolean;
  isOpen?: boolean;
  mode?: "create" | "edit";
  initial?: NewTriggerInitial | null;
  existingIds?: string[];
  onClose: () => void;
  onCreated: (trigger: TriggerListItem) => void;
};

const MONO = "[font-family:'Geist_Mono',_monospace]";
const SECTION_LABEL =
  "w-fit text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase";
const FIELD_LABEL = "w-fit text-[#a7aab2] font-sans text-xs leading-normal";
const INPUT_SHELL =
  "flex h-8 items-center bg-[#1a1c21] border rounded-lg px-2.5 gap-2 border-[#ffffff1a] focus-within:border-[#ecedee73] focus-within:shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]";
const INPUT_TEXT = `min-w-0 flex-1 bg-transparent text-[#ecedee] ${MONO} text-xs leading-normal outline-none placeholder:text-[#8b8f98]`;
const ERROR_TEXT = "text-[11px] text-[var(--sf-fail)]";

const KIND_CARDS: { kind: TriggerKind; title: string; hint: string; icon: IconType }[] = [
  { kind: "schedule", title: "Schedule", hint: "cron + timezone", icon: LuClock },
  { kind: "event", title: "Event", hint: "PR, webhook, email", icon: LuZap },
  { kind: "manual", title: "Manual", hint: "UI, CLI, MCP", icon: LuMousePointerClick },
];

const SOURCE_TILES: {
  source: EventSourceKind;
  title: string;
  meta: string;
  metaMono: boolean;
  icon: IconType;
}[] = [
  { source: "github", title: "GitHub pull request", meta: "polls every 60s", metaMono: false, icon: LuGithub },
  { source: "webhook", title: "Signed webhook", meta: "POST /api/triggers/:id/webhook", metaMono: true, icon: LuWebhook },
  { source: "email", title: "Email", meta: "IMAP IDLE", metaMono: false, icon: LuMail },
];

const SOURCE_TITLES: Record<EventSourceKind, string> = {
  github: "GitHub pull request",
  webhook: "Signed webhook",
  email: "Email",
};

const SCHEDULE_DYNAMIC_WARNING = "Schedule + Dynamic task cannot auto-fire. Pick a catalog task.";

function FieldError({ message }: { message?: string }) {
  return message ? <p className={ERROR_TEXT}>{message}</p> : null;
}

function TextField({
  label,
  labelExtra,
  icon: Icon,
  value,
  onChange,
  placeholder,
  error,
  inputMode,
  ariaLabel,
}: {
  label: string;
  labelExtra?: ReactNode;
  icon?: IconType;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  inputMode?: "numeric";
  ariaLabel?: string;
}) {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className="flex items-center gap-1.5">
        <span className={FIELD_LABEL}>{label}</span>
        {labelExtra}
      </span>
      <span className={INPUT_SHELL}>
        {Icon ? <Icon className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden /> : null}
        <input
          className={INPUT_TEXT}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          aria-label={ariaLabel ?? label}
          autoComplete="off"
          spellCheck={false}
        />
      </span>
      <FieldError message={error} />
    </label>
  );
}

function SecretRefLabel({ hint }: { hint?: string }) {
  return (
    <>
      <span className={`w-fit text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>secretRef</span>
      {hint ? (
        <span className="flex-1 text-right text-[#8b8f98] font-sans text-[11px] leading-normal">
          {hint}
        </span>
      ) : null}
    </>
  );
}

function RadioDot({ selected, size }: { selected: boolean; size: "sm" | "md" }) {
  const outer = size === "md" ? "size-3.5" : "size-3";
  const inner = size === "md" ? "size-1.5" : "size-[5px]";
  return selected ? (
    <span className={`${outer} flex shrink-0 items-center justify-center rounded-full bg-[#ecedee]`}>
      <span className={`${inner} block rounded-full bg-[#0c0d0f]`} />
    </span>
  ) : (
    <span className={`${outer} block shrink-0 rounded-full border border-[#ffffff2e]`} />
  );
}

const YAML_INDENT = ["", "pl-4", "pl-8", "pl-12", "pl-16"];

function YamlLine({ index, line }: { index: number; line: string }) {
  const depth = Math.floor((line.length - line.trimStart().length) / 2);
  const body = line.trimStart();
  const sep = body.indexOf(": ");
  const key = sep >= 0 ? body.slice(0, sep + 2) : body;
  const value = sep >= 0 ? body.slice(sep + 2) : "";
  const keyword = value === "true" || value === "false" || key === "kind: ";
  return (
    <div className="flex gap-3.5 px-3">
      <span className={`w-3.5 shrink-0 text-right text-[#3a3d44] ${MONO} text-xs leading-[1.33333]`}>
        {index + 1}
      </span>
      <span
        className={`block whitespace-pre text-[#8b8f98] ${MONO} text-xs leading-[1.33333] ${
          YAML_INDENT[Math.min(depth, YAML_INDENT.length - 1)]
        }`}
      >
        {key}
        {value ? (
          <span className={keyword ? "text-[#b7c7e8]" : "text-[#ecedee]"}>{value}</span>
        ) : null}
      </span>
    </div>
  );
}

export function NewTriggerModal({
  open,
  isOpen,
  mode = "create",
  initial = null,
  existingIds = [],
  onClose,
  onCreated,
}: NewTriggerModalProps) {
  const visible = open ?? isOpen ?? false;
  const isEdit = mode === "edit";
  const [form, setForm] = useState<NewTriggerForm>(() => formFromInitial(initial));
  const [pipelines, setPipelines] = useState<PipelineListing[] | null>(null);
  const [tasks, setTasks] = useState<TaskListing[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const idInputRef = useRef<HTMLInputElement | null>(null);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const initialKey = initial ? `${mode}:${initial.id}` : mode;

  useEffect(() => {
    if (!visible) return;
    setForm(formFromInitial(initialRef.current));
    setShowErrors(false);
    setBanner(null);
    setSubmitting(false);
    setCopied(false);
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
  }, [visible, initialKey]);

  useEffect(() => {
    if (visible && !isEdit) idInputRef.current?.focus();
  }, [visible, isEdit]);

  const errors: NewTriggerFieldErrors = useMemo(
    () => validateNewTriggerForm(form, mode),
    [form, mode],
  );
  const idTaken = !isEdit && existingIds.includes(form.id.trim());
  const valid = Object.keys(errors).length === 0 && !idTaken;
  const shown = (key: keyof NewTriggerFieldErrors) => (showErrors ? errors[key] : undefined);

  const yamlPreview = useMemo(
    () =>
      buildTriggerYamlPreview({
        id: form.id,
        pipeline: form.pipeline,
        task: form.taskMode === "catalog" ? form.task : undefined,
        kind: form.kind,
        enabled: form.enabled,
        schedule:
          form.kind === "schedule"
            ? {
                cron: form.cron.trim(),
                ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
              }
            : undefined,
        event: form.kind === "event" ? buildTriggerEvent(form) : undefined,
      }),
    [form],
  );
  const yamlLines = useMemo(() => yamlPreview.replace(/\n$/, "").split("\n"), [yamlPreview]);

  const scheduleRuns = useMemo(() => {
    if (form.kind !== "schedule") return { runs: [] as Date[], error: null as string | null };
    try {
      const tz = form.timezone.trim();
      return {
        runs: nextScheduleRuns(
          { cron: form.cron.trim(), ...(tz ? { timezone: tz } : {}) },
          new Date(),
          3,
        ),
        error: null,
      };
    } catch {
      return { runs: [], error: "Invalid cron expression." };
    }
  }, [form.kind, form.cron, form.timezone]);

  const pipelineOptions = useMemo(() => {
    const list = pipelines ?? [];
    if (form.pipeline && !list.some((p) => p.id === form.pipeline)) {
      return [{ id: form.pipeline, stages: null as number | null }, ...list.map((p) => ({ id: p.id, stages: p.stages.length }))];
    }
    return list.map((p) => ({ id: p.id, stages: p.stages.length as number | null }));
  }, [pipelines, form.pipeline]);
  const selectedStages = pipelineOptions.find((p) => p.id === form.pipeline)?.stages ?? null;

  const taskOptions = useMemo(() => {
    const ids = (tasks ?? []).map((t) => t.id);
    if (form.task && !ids.includes(form.task)) ids.unshift(form.task);
    return ids;
  }, [tasks, form.task]);

  const handleClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [onClose, submitting]);

  const submit = useCallback(async () => {
    setShowErrors(true);
    setBanner(null);
    if (!valid || submitting) return;
    setSubmitting(true);
    if (isEdit) {
      try {
        const trigger = await updateTrigger(initial?.id ?? form.id, buildUpdateTriggerBody(form));
        setSubmitting(false);
        onCreated(trigger);
        onClose();
      } catch (err) {
        setSubmitting(false);
        setBanner(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const directory = directoryForPipeline(pipelines ?? [], form.pipeline);
    const result = await createTriggerWithDetails(buildCreateTriggerBody(form, directory));
    setSubmitting(false);
    if (result.ok) {
      onCreated(result.trigger);
      onClose();
      return;
    }
    setBanner(triggerCreateBanner(result.status, result.error));
  }, [valid, submitting, isEdit, initial, form, pipelines, onCreated, onClose]);

  useHotkeys(
    [
      {
        key: "escape",
        scope: "global",
        when: () => visible,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          handleClose();
        },
      },
      {
        key: "mod+enter",
        scope: "global",
        when: () => visible,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          void submit();
        },
      },
    ],
    "global",
  );

  if (!visible) return null;

  const update = (patch: Partial<NewTriggerForm>) => setForm((prev) => ({ ...prev, ...patch }));
  const updateGithub = (patch: Partial<NewTriggerForm["github"]>) =>
    setForm((prev) => ({ ...prev, github: { ...prev.github, ...patch } }));
  const updateWebhook = (patch: Partial<NewTriggerForm["webhook"]>) =>
    setForm((prev) => ({ ...prev, webhook: { ...prev.webhook, ...patch } }));
  const updateEmail = (patch: Partial<NewTriggerForm["email"]>) =>
    setForm((prev) => ({ ...prev, email: { ...prev.email, ...patch } }));

  const onDialogKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const copyYaml = () => {
    void navigator.clipboard?.writeText(yamlPreview).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  const needsHost =
    form.kind === "schedule" ||
    (form.kind === "event" && (form.source === "github" || form.source === "email"));
  const cronHuman = describeCron(form.cron);
  const tzOptions = timezoneOptions(form.timezone);
  const idTrimmed = form.id.trim();
  const idFormatOk = !isEdit && idTrimmed !== "" && !errors.id;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#040506a8] p-4"
      role="presentation"
      onClick={handleClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[740px] flex-col overflow-y-auto rounded-xl border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-trigger-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <div className="flex w-full items-start gap-3 px-5 pb-2.5 pt-3.5">
          <div className="flex flex-1 flex-col gap-[3px]">
            <h2
              id="new-trigger-title"
              className="w-fit text-[#ecedee] font-sans text-lg font-semibold leading-normal tracking-[-0.36px]"
            >
              {isEdit ? "Edit trigger" : "New trigger"}
            </h2>
            <p className="text-[#a7aab2] font-sans text-[13px] leading-normal">
              Starts a pipeline on a schedule, on an event, or by hand. Saved as a{" "}
              <span className={`text-[#ecedee] ${MONO} text-xs`}>.trigger.yaml</span> file.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <span className={`rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] py-px text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>
              esc
            </span>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-lg text-[#a7aab2] hover:bg-[#1a1c21]"
              onClick={handleClose}
              aria-label="Close"
            >
              <LuX className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        {banner ? (
          <div className="px-5 pb-3">
            <p
              className="rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2 text-xs text-[var(--sf-fail)]"
              role="alert"
            >
              {banner}
            </p>
          </div>
        ) : null}

        <div className="flex w-full flex-col gap-3 px-5 pb-3">
          <div className="flex w-full items-end gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="new-trigger-id" className={SECTION_LABEL}>
                  Id
                </label>
                {isEdit ? (
                  <span className="text-[#8b8f98] font-sans text-[11px] leading-normal">read-only</span>
                ) : idTaken ? (
                  <span className="text-[var(--sf-fail)] font-sans text-[11px] leading-normal">id is taken</span>
                ) : idFormatOk ? (
                  <span className="flex items-center gap-1">
                    <LuCheck className="size-3 text-[#4cc38a]" aria-hidden />
                    <span className="text-[#4cc38a] font-sans text-[11px] leading-normal">id is free</span>
                  </span>
                ) : null}
              </div>
              <div className={`${INPUT_SHELL} gap-0.5`}>
                <input
                  id="new-trigger-id"
                  ref={idInputRef}
                  className={`min-w-0 flex-1 bg-transparent text-[#ecedee] ${MONO} text-[13px] leading-normal outline-none placeholder:text-[#8b8f98] read-only:text-[#a7aab2]`}
                  value={form.id}
                  readOnly={isEdit}
                  onChange={(e) => update({ id: e.target.value })}
                  placeholder="kebab-case"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className={`text-[#8b8f98] ${MONO} text-xs leading-normal`}>kebab-case</span>
              </div>
              <FieldError message={shown("id")} />
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              className="flex h-8 shrink-0 items-center gap-2.5 rounded-lg border border-[#ffffff12] bg-[#0f1013] px-2.5"
              onClick={() => update({ enabled: !form.enabled })}
            >
              <span className="text-[#ecedee] font-sans text-[13px] leading-normal">Enabled</span>
              <span
                className={`flex h-[18px] w-[30px] items-center rounded-full px-0.5 ${
                  form.enabled ? "justify-end bg-[#ecedee]" : "justify-start bg-[#2a2d33]"
                }`}
              >
                <span className="block size-3.5 rounded-full bg-[#0c0d0f]" />
              </span>
            </button>
          </div>

          <div className="flex w-full flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className={SECTION_LABEL}>When</span>
              <span className={`w-fit text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>
                kind: {form.kind}
              </span>
            </div>
            <div className="grid w-full grid-cols-3 gap-2" role="radiogroup" aria-label="When">
              {KIND_CARDS.map(({ kind, title, hint, icon: Icon }) => {
                const selected = form.kind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`flex h-9 items-center gap-2 rounded-[10px] border px-3 text-left ${
                      selected
                        ? "border-[#ecedee] bg-[#1a1c21] shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]"
                        : "border-[#ffffff1a] bg-[#0f1013]"
                    }`}
                    onClick={() => update({ kind })}
                  >
                    <Icon
                      className={`size-[15px] shrink-0 ${selected ? "text-[#ecedee]" : "text-[#8b8f98]"}`}
                      aria-hidden
                    />
                    <span className="w-fit text-[#ecedee] font-sans text-[13px] font-medium leading-normal">
                      {title}
                    </span>
                    <span
                      className={`flex-1 truncate font-sans text-[11px] leading-normal ${
                        selected ? "text-[#a7aab2]" : "text-[#8b8f98]"
                      }`}
                    >
                      {hint}
                    </span>
                    <RadioDot selected={selected} size="md" />
                  </button>
                );
              })}
            </div>
            {form.kind === "event" ? (
              <div className="grid w-full grid-cols-3 gap-2" role="radiogroup" aria-label="Event source">
                {SOURCE_TILES.map(({ source, title, meta, metaMono, icon: Icon }) => {
                  const selected = form.source === source;
                  return (
                    <button
                      key={source}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex flex-col gap-0.5 rounded-lg border px-2.5 py-[7px] text-left ${
                        selected
                          ? "border-[#ecedee59] bg-[#1a1c21] shadow-[inset_0px_2px_0px_rgb(236,237,238)]"
                          : "border-[#ffffff14] bg-[#0f1013]"
                      }`}
                      onClick={() => update({ source })}
                    >
                      <span className="flex items-center gap-2">
                        <RadioDot selected={selected} size="sm" />
                        <Icon
                          className={`size-3.5 shrink-0 ${selected ? "text-[#ecedee]" : "text-[#8b8f98]"}`}
                          aria-hidden
                        />
                        <span
                          className={`w-fit font-sans text-[13px] leading-normal ${
                            selected ? "font-medium text-[#ecedee]" : "text-[#a7aab2]"
                          }`}
                        >
                          {title}
                        </span>
                      </span>
                      <span
                        className={`block truncate pl-5 leading-normal ${
                          metaMono ? `${MONO} text-[10px]` : "font-sans text-[11px]"
                        } ${selected ? "text-[#a7aab2]" : "text-[#8b8f98]"}`}
                      >
                        {meta}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        {form.kind === "event" ? (
          <div className="flex w-full flex-col gap-2 px-5 pb-3">
            <div className="flex items-center gap-3">
              <span className={`${SECTION_LABEL} flex-1`}>{SOURCE_TITLES[form.source]}</span>
              {form.source === "github" ? (
                <span className="flex items-center gap-1.5">
                  <LuInfo className="size-3 shrink-0 text-[#a7aab2]" aria-hidden />
                  <span className="text-[#a7aab2] font-sans text-[11px] leading-normal">
                    First poll only records existing PRs. Nothing old is started.
                  </span>
                </span>
              ) : null}
            </div>
            <div className="flex w-full flex-col gap-2 rounded-[10px] border border-[#ffffff12] bg-[#0f1013] p-2.5">
              {form.source === "github" ? (
                <>
                  <div className="grid w-full grid-cols-2 gap-3">
                    <TextField
                      label="Repo"
                      icon={LuGithub}
                      value={form.github.repo}
                      onChange={(repo) => updateGithub({ repo })}
                      placeholder="owner/name"
                      error={shown("repo")}
                    />
                    <TextField
                      label="Token"
                      ariaLabel="Token secretRef"
                      labelExtra={<SecretRefLabel hint="env var name, not the token" />}
                      icon={LuKeyRound}
                      value={form.github.secretRef}
                      onChange={(secretRef) => updateGithub({ secretRef })}
                      placeholder="GITHUB_TOKEN"
                    />
                  </div>
                  <div className="flex w-full items-center gap-3">
                    <span className={`${FIELD_LABEL} w-[52px] shrink-0`}>Action</span>
                    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Action">
                      {GITHUB_ACTIONS.map((action) => {
                        const selected = form.github.action === action;
                        return (
                          <button
                            key={action}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`flex h-[26px] items-center gap-[5px] rounded-full px-2.5 ${MONO} text-xs leading-normal ${
                              selected
                                ? "bg-[#ecedee] font-medium text-[#0c0d0f]"
                                : "border border-[#ffffff1a] text-[#a7aab2]"
                            }`}
                            onClick={() => updateGithub({ action })}
                          >
                            {selected ? <LuCheck className="size-3" aria-hidden /> : null}
                            {action}
                          </button>
                        );
                      })}
                    </div>
                    <span className="block h-[18px] w-px bg-[#ffffff12]" />
                    <span className={`${FIELD_LABEL} shrink-0`}>Author</span>
                    <span className="flex h-7 flex-1 items-center gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5">
                      <input
                        className="min-w-0 flex-1 bg-transparent text-[#ecedee] font-sans text-xs leading-normal outline-none placeholder:text-[#8b8f98]"
                        value={form.github.author}
                        onChange={(e) => updateGithub({ author: e.target.value })}
                        placeholder="any author (optional)"
                        aria-label="Author"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </span>
                  </div>
                </>
              ) : null}
              {form.source === "webhook" ? (
                <div className="grid w-full grid-cols-[minmax(0px,_1fr)_minmax(0px,_1fr)_120px] gap-3">
                  <TextField
                    label="Secret"
                    ariaLabel="Webhook secretRef"
                    labelExtra={<SecretRefLabel />}
                    icon={LuKeyRound}
                    value={form.webhook.secretRef}
                    onChange={(secretRef) => updateWebhook({ secretRef })}
                    placeholder="WEBHOOK_SECRET"
                    error={shown("secretRef")}
                  />
                  <TextField
                    label="Header"
                    value={form.webhook.header}
                    onChange={(header) => updateWebhook({ header })}
                    placeholder="X-Hub-Signature-256"
                    error={shown("header")}
                  />
                  <label className="flex flex-col gap-[5px]">
                    <span className={FIELD_LABEL}>Scheme</span>
                    <span className={INPUT_SHELL}>
                      <select
                        className={`${INPUT_TEXT} appearance-none`}
                        value={form.webhook.scheme}
                        onChange={(e) =>
                          updateWebhook({ scheme: e.target.value === "base64" ? "base64" : "hex" })
                        }
                        aria-label="Scheme"
                      >
                        <option value="hex">hex</option>
                        <option value="base64">base64</option>
                      </select>
                      <LuChevronDown className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                    </span>
                  </label>
                </div>
              ) : null}
              {form.source === "email" ? (
                <>
                  <div className="grid w-full grid-cols-[minmax(0px,_1fr)_96px] gap-3">
                    <TextField
                      label="Host"
                      icon={LuMail}
                      value={form.email.host}
                      onChange={(host) => updateEmail({ host })}
                      placeholder="imap.example.com"
                      error={shown("host")}
                    />
                    <TextField
                      label="Port"
                      value={form.email.port}
                      onChange={(port) => updateEmail({ port })}
                      placeholder="993"
                      inputMode="numeric"
                      error={shown("port")}
                    />
                  </div>
                  <div className="grid w-full grid-cols-2 gap-3">
                    <TextField
                      label="User"
                      value={form.email.user}
                      onChange={(user) => updateEmail({ user })}
                      placeholder="agent@example.com"
                      error={shown("user")}
                    />
                    <TextField
                      label="Password"
                      ariaLabel="Email secretRef"
                      labelExtra={<SecretRefLabel hint="env var name, not the password" />}
                      icon={LuKeyRound}
                      value={form.email.secretRef}
                      onChange={(secretRef) => updateEmail({ secretRef })}
                      placeholder="EMAIL_PASSWORD"
                      error={shown("secretRef")}
                    />
                  </div>
                  <TextField
                    label="Subject"
                    labelExtra={
                      <span className="text-[#8b8f98] font-sans text-[11px] leading-normal">
                        exact match, optional
                      </span>
                    }
                    value={form.email.subject}
                    onChange={(subject) => updateEmail({ subject })}
                    placeholder="any subject"
                  />
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {form.kind === "schedule" ? (
          <div className="flex w-full flex-col px-5 pb-3">
            <div className="flex w-full flex-col gap-2.5 rounded-xl border border-dashed border-[#ffffff24] bg-[#131418] p-3 shadow-[0px_16px_48px_rgba(0,0,0,0.5)]">
              <div className="flex items-center gap-1.5">
                <LuClock className="size-3.5 text-[#ecedee]" aria-hidden />
                <span className="flex-1 text-[#ecedee] font-sans text-[13px] font-medium leading-normal">
                  Schedule
                </span>
                <span className={`text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>kind: schedule</span>
              </div>
              <label className="flex flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Cron</span>
                <span className={INPUT_SHELL}>
                  <input
                    className={`min-w-0 flex-1 bg-transparent text-[#ecedee] ${MONO} text-[13px] leading-normal tracking-[1.56px] outline-none placeholder:text-[#8b8f98]`}
                    value={form.cron}
                    onChange={(e) => update({ cron: e.target.value })}
                    placeholder="0 2 * * *"
                    aria-label="Cron"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </span>
                <span className="grid grid-cols-5 gap-1 px-0.5">
                  {["min", "hour", "day", "month", "wkday"].map((part) => (
                    <span key={part} className={`w-fit text-[#8b8f98] ${MONO} text-[10px] leading-normal`}>
                      {part}
                    </span>
                  ))}
                </span>
                <span className="w-fit text-[#ecedee] font-sans text-[13px] leading-normal">
                  {cronHuman ?? (form.cron.trim() || "No cron set")}
                </span>
                <FieldError message={shown("cron")} />
              </label>
              <label className="flex flex-col gap-[5px]">
                <span className={FIELD_LABEL}>Timezone</span>
                <span className={INPUT_SHELL}>
                  <LuGlobe className="size-[13px] shrink-0 text-[#8b8f98]" aria-hidden />
                  <select
                    className={`${INPUT_TEXT} appearance-none`}
                    value={form.timezone}
                    onChange={(e) => update({ timezone: e.target.value })}
                    aria-label="Timezone"
                  >
                    {form.timezone === "" ? <option value="">host default</option> : null}
                    {tzOptions.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                  <LuChevronDown className="size-[13px] shrink-0 text-[#8b8f98]" aria-hidden />
                </span>
              </label>
              <div className="flex flex-col gap-1 border-t border-t-[#ffffff0f] pt-2">
                <span className={SECTION_LABEL}>Next 3 runs</span>
                {scheduleRuns.error ? (
                  <span className="text-[#a7aab2] font-sans text-xs leading-normal">{scheduleRuns.error}</span>
                ) : scheduleRuns.runs.length === 0 ? (
                  <span className="text-[#8b8f98] font-sans text-xs leading-normal">No upcoming runs.</span>
                ) : (
                  scheduleRuns.runs.map((run, i) => {
                    const label = formatNextRun(run, new Date(), form.timezone.trim());
                    return (
                      <div key={run.toISOString()} className="flex items-center justify-between">
                        <span
                          className={`w-fit ${MONO} text-xs leading-normal ${
                            i === 0 ? "text-[#ecedee]" : "text-[#a7aab2]"
                          }`}
                        >
                          {label.date}
                        </span>
                        <span className="w-fit text-[#8b8f98] font-sans text-[11px] leading-normal">
                          {label.relative}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
              {form.taskMode === "dynamic" ? (
                <div className="flex items-start gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2">
                  <LuCircleAlert className="mt-px size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
                  <span className="text-[#a7aab2] font-sans text-xs leading-[1.4]">
                    {SCHEDULE_DYNAMIC_WARNING}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {form.kind === "manual" ? (
          <div className="px-5 pb-3">
            <p className="rounded-[10px] border border-[#ffffff12] bg-[#0f1013] px-3 py-2.5 text-[#a7aab2] font-sans text-xs leading-normal">
              Nothing runs until you fire it from the UI, CLI, or MCP.
            </p>
          </div>
        ) : null}

        <div className="flex w-full flex-col gap-2 px-5 pb-3">
          <div className="flex items-center justify-between">
            <span className={SECTION_LABEL}>Then run</span>
            <span className={`w-fit text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>
              {form.taskMode === "dynamic" ? "pipeline · task (omitted)" : "pipeline · task"}
            </span>
          </div>
          <div className="grid w-full grid-cols-2 gap-3">
            <label className="flex h-9 items-center gap-2.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 focus-within:border-[#ecedee73]">
              <LuWorkflow className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
              <select
                className={`min-w-0 flex-1 appearance-none bg-transparent text-[#ecedee] ${MONO} text-[13px] leading-normal outline-none`}
                value={form.pipeline}
                onChange={(e) => update({ pipeline: e.target.value })}
                disabled={pipelines === null}
                aria-label="Pipeline"
              >
                <option value="">{pipelines === null ? "Loading pipelines…" : "Select a pipeline"}</option>
                {pipelineOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
              {selectedStages !== null ? (
                <span className="w-fit shrink-0 text-[#8b8f98] font-sans text-[11px] leading-normal">
                  {selectedStages} {selectedStages === 1 ? "stage" : "stages"}
                </span>
              ) : null}
              <LuChevronDown className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
            </label>
            <div
              className="flex h-9 items-center gap-[3px] rounded-lg border border-[#ffffff1a] bg-[#0f1013] p-[3px]"
              role="radiogroup"
              aria-label="Task mode"
            >
              {(["catalog", "dynamic"] as const).map((taskMode) => {
                const selected = form.taskMode === taskMode;
                return (
                  <button
                    key={taskMode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`flex h-full flex-1 items-center justify-center gap-1.5 rounded-md font-sans text-[13px] leading-normal ${
                      selected
                        ? "border border-[#ffffff1f] bg-[#1a1c21] font-medium text-[#ecedee]"
                        : "text-[#a7aab2]"
                    }`}
                    onClick={() => update({ taskMode })}
                  >
                    {taskMode === "dynamic" && selected ? (
                      <LuSparkles className="size-[13px]" aria-hidden />
                    ) : null}
                    {taskMode === "catalog" ? "Catalog task" : "Dynamic task"}
                  </button>
                );
              })}
            </div>
          </div>
          <FieldError message={shown("pipeline")} />
          {form.taskMode === "catalog" ? (
            <>
              <label className="flex h-9 items-center gap-2.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 focus-within:border-[#ecedee73]">
                <LuFileCode className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                <select
                  className={`min-w-0 flex-1 appearance-none bg-transparent text-[#ecedee] ${MONO} text-[13px] leading-normal outline-none`}
                  value={form.task}
                  onChange={(e) => update({ task: e.target.value })}
                  disabled={tasks === null}
                  aria-label="Task"
                >
                  <option value="">{tasks === null ? "Loading tasks…" : "Select a task"}</option>
                  {taskOptions.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <LuChevronDown className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
              </label>
              <FieldError message={shown("task")} />
            </>
          ) : (
            <div className="flex w-full gap-3">
              <div className="flex w-[236px] shrink-0 flex-col justify-center gap-1">
                <span className="text-[#a7aab2] font-sans text-xs leading-[1.4]">
                  Each event becomes the task. Title, number, url, author and repo are passed in when the source provides them.
                </span>
                {form.kind === "event" && form.source === "github" ? (
                  <span className="w-fit text-[#8b8f98] font-sans text-[11px] leading-normal">
                    Preview from sample PR #482 →
                  </span>
                ) : null}
              </div>
              {form.kind === "schedule" ? (
                <div className="flex flex-1 items-start gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2">
                  <LuCircleAlert className="mt-px size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
                  <span className="text-[#a7aab2] font-sans text-xs leading-[1.4]">
                    {SCHEDULE_DYNAMIC_WARNING}
                  </span>
                </div>
              ) : form.kind === "event" && form.source === "github" ? (
                <div className="flex flex-1 flex-col gap-1 rounded-[10px] border border-dashed border-[#ffffff1f] bg-[#0f1013] px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className={`w-[52px] shrink-0 text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>goal</span>
                    <span className="w-fit text-[#ecedee] font-sans text-[13px] font-medium leading-normal">
                      Review PR #482: Add trigger history table
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className={`w-[52px] shrink-0 text-[#8b8f98] ${MONO} text-[11px] leading-[1.45455]`}>
                      context
                    </span>
                    <div className="flex flex-1 flex-col">
                      <span className={`w-fit text-[#a7aab2] ${MONO} text-[11px] leading-[1.45455]`}>
                        number: 482 · author: tejasghutukade · action: opened
                      </span>
                      <span className={`w-fit text-[#a7aab2] ${MONO} text-[11px] leading-[1.45455]`}>
                        url: github.com/tejasghutukade/software-factory/pull/482
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex w-full gap-3 px-5 pb-3">
          <div className="flex w-[236px] shrink-0 flex-col gap-2 rounded-[10px] border border-[#ffffff12] bg-[#0f1013] px-3 py-2.5">
            <span className={SECTION_LABEL}>{valid ? "Ready" : "Not ready"}</span>
            {form.pipeline ? (
              <div className="flex items-center gap-1.5">
                <LuCheck className="size-3.5 shrink-0 text-[#4cc38a]" aria-hidden />
                <span className="w-fit text-[#ecedee] font-sans text-xs leading-normal">Pipeline valid</span>
                <span className={`w-fit text-[#4cc38a] ${MONO} text-[11px] leading-normal`}>(strict)</span>
              </div>
            ) : null}
            <div className="block h-px w-full bg-[#ffffff0f]" />
            {form.kind === "event" && form.source === "github" ? (
              <div className="flex items-start gap-1.5">
                <LuKeyRound className="mt-px size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
                <span className="text-[#a7aab2] font-sans text-xs leading-[1.33333]">
                  <span className={`text-[#ecedee] ${MONO} text-[11px]`}>
                    {form.github.secretRef.trim() || "GITHUB_TOKEN"}
                  </span>{" "}
                  — name only, checked on the host
                </span>
              </div>
            ) : null}
            <div className="flex items-start gap-1.5">
              <LuInfo className="mt-px size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
              <span className="text-[#a7aab2] font-sans text-xs leading-[1.33333]">
                Runs queue when all agent slots are busy
              </span>
            </div>
            {needsHost ? (
              <div className="flex items-start gap-1.5">
                <LuInfo className="mt-px size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
                <span className="text-[#a7aab2] font-sans text-xs leading-[1.33333]">
                  Needs the <span className={`text-[#ecedee] ${MONO} text-[11px]`}>sf ui</span> host running to poll
                </span>
              </div>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-clip rounded-[10px] border border-[#ffffff12] bg-[#0c0d0f]">
            <div className="flex h-8 w-full items-center gap-2 border-b border-b-[#ffffff0f] px-3">
              <span className="w-fit text-[#ecedee] font-sans text-xs font-medium leading-normal">YAML preview</span>
              <LuFileCode className="ml-1.5 size-3 shrink-0 text-[#8b8f98]" aria-hidden />
              <span className={`min-w-0 flex-1 truncate text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>
                {triggerYamlPath(form.id, initial?.path)}
              </span>
              <button
                type="button"
                className="flex h-[22px] items-center gap-[5px] rounded-md px-1.5 text-[#8b8f98] hover:bg-[#1a1c21]"
                onClick={copyYaml}
                aria-label="Copy YAML"
              >
                <LuCopy className="size-3" aria-hidden />
                <span className="font-sans text-[11px] leading-normal">{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <div className="flex w-full flex-col overflow-x-auto py-1.5" aria-label="YAML preview">
              {yamlLines.map((line, i) => (
                <YamlLine key={i} index={i} line={line} />
              ))}
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 mt-auto flex w-full items-center gap-2 border-t border-t-[#ffffff12] bg-[#101114] px-5 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <LuTerminal className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
            <span className={`truncate text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>
              {triggerFireCommand(isEdit ? initial?.id ?? form.id : form.id)}
            </span>
          </div>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg px-3 hover:bg-[#1a1c21]"
            onClick={handleClose}
          >
            <span className="text-[#a7aab2] font-sans text-[13px] font-medium leading-normal">Cancel</span>
            <span className={`text-[#8b8f98] ${MONO} text-[11px] leading-normal`}>esc</span>
          </button>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg bg-[#ecedee] px-3 disabled:opacity-50"
            onClick={() => void submit()}
            disabled={submitting || pipelines === null || tasks === null}
          >
            <span className="text-[#0c0d0f] font-sans text-[13px] font-medium leading-normal">
              {submitting
                ? isEdit
                  ? "Saving…"
                  : "Creating…"
                : isEdit
                  ? "Save"
                  : "Create trigger"}
            </span>
            {isEdit ? null : (
              <span className={`text-[#5a5e66] ${MONO} text-[11px] leading-normal`}>⌘↵</span>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
