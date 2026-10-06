import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { lastRunAtForTask } from "../../catalog/stats";
import { relativeTime } from "../../catalogJoin";
import { Keycap } from "../Keycap";
import { useHotkeys } from "../keys";
import {
  MODAL_SCRIM_PT,
  OVERLAY_SCRIM_CLASS,
} from "../overlay/overlayScrimClasses";
import { useOverlayChrome } from "../overlay/useOverlayChrome";
import { PipelineRunCard } from "./PipelineRunCard";
import { useStartRunForm } from "./useStartRunForm";
import {
  LuCheck,
  LuChevronRight,
  LuCircleAlert,
  LuCopy,
  LuPlay,
  LuSearch,
  LuTerminal,
  LuX,
} from "react-icons/lu";

export type StartRunDialogProps = {
  open: boolean;
  onClose: () => void;
  onStarted: (runId: string) => void;
  initialTaskPath?: string;
  initialPipelinePath?: string;
};

export function StartRunDialog({
  open,
  onClose,
  onStarted,
  initialTaskPath,
  initialPipelinePath,
}: StartRunDialogProps) {
  const { snapshot, error: catalogError } = useRunCatalog();
  const inputRef = useRef<HTMLInputElement>(null);
  const form = useStartRunForm({
    open,
    snapshot,
    catalogError,
    initialTaskPath,
    initialPipelinePath,
    onStarted: (id) => {
      onStarted(id);
      onClose();
    },
  });

  useOverlayChrome(open);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  useHotkeys(
    [
      {
        key: "mod+enter",
        scope: "global",
        when: () => open && form.canStart,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          void form.submit();
        },
      },
    ],
    "global",
  );

  if (!open) return null;

  async function copyCli() {
    try {
      await navigator.clipboard.writeText(form.cliLine);
    } catch {
      /* empty */
    }
  }

  const slotsInUse = form.health?.activeCount ?? 0;
  const slotsMax = form.health?.maxConcurrent ?? 0;
  const slotsLabel =
    slotsMax > 0
      ? `${slotsInUse} of ${slotsMax} agent slots in use${
          form.slotsFull
            ? " — no slots left"
            : slotsInUse === slotsMax - 1
              ? " — this run takes the last one"
              : ""
        }`
      : null;

  return createPortal(
    <div
      className={`${OVERLAY_SCRIM_CLASS} ${MODAL_SCRIM_PT}`}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="flex w-[720px] min-w-0 max-h-[min(900px,calc(100vh-2.75rem))] flex-col overflow-clip rounded-[14px] border border-[#ffffff1a] bg-[var(--sf-panel)] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-start-run-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex w-full shrink-0 items-start gap-3 px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2
              id="sf-start-run-title"
              className="font-sans text-lg font-semibold tracking-[-0.36px] text-[var(--sf-text-1)]"
            >
              Start a run
            </h2>
            <p className="font-sans text-[13px] text-[var(--sf-text-2)]">
              A run pairs one task with one pipeline. It holds an agent slot until it finishes.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <Keycap className="text-[var(--sf-text-3)]">esc</Keycap>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-lg"
              onClick={onClose}
              aria-label="Close"
            >
              <LuX className="size-4 text-[var(--sf-text-2)]" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <section className="flex w-full flex-col gap-2 px-5 pb-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                Task
              </span>
              <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
                {form.tasks.length} in tasks/
              </span>
            </div>
            <div className="flex min-h-0 flex-col overflow-clip rounded-[10px] border border-[#ffffff1a] bg-[#0f1013]">
              <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-3 py-0">
                <LuSearch className="size-3.5 text-[var(--sf-text-3)]" aria-hidden="true" />
                <input
                  ref={inputRef}
                  className="min-w-0 flex-1 border-none bg-transparent font-sans text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
                  placeholder="Search tasks by id or goal…"
                  value={form.taskQuery}
                  onChange={(e) => form.setTaskQuery(e.target.value)}
                />
                <Keycap className="text-[var(--sf-text-3)]">/</Keycap>
              </div>
              <div className="max-h-[min(320px,calc(900px-28rem))] min-h-0 overflow-y-auto">
                {form.filteredTasks.map((t) => {
                  const selected = form.task === t.path;
                  const last = lastRunAtForTask(snapshot.runs, t.path);
                  if (selected) {
                    return (
                      <button
                        key={t.path}
                        type="button"
                        className="flex w-full items-start gap-2.5 bg-[var(--sf-raised)] px-3 py-[9px] text-left shadow-[inset_2px_0px_0px_rgb(236,237,238)]"
                        onClick={() => form.setTask(t.path)}
                      >
                        <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--sf-text-1)]">
                          <span className="size-1.5 rounded-full bg-[var(--sf-ground)]" />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                          <span className="font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">
                            {t.id}
                          </span>
                          <span className="line-clamp-2 font-sans text-[13px] text-[var(--sf-text-2)]">
                            {t.goal}
                          </span>
                        </span>
                        {last ? (
                          <span className="mt-0.5 shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
                            last run {relativeTime(last)}
                          </span>
                        ) : null}
                        <LuCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--sf-text-1)]" aria-hidden="true" />
                      </button>
                    );
                  }
                  return (
                    <button
                      key={t.path}
                      type="button"
                      className="flex h-9 w-full items-center gap-2.5 border-t border-t-[#ffffff0d] px-3 py-0 text-left"
                      onClick={() => form.setTask(t.path)}
                    >
                      <span className="size-3.5 shrink-0 rounded-full border border-[#ffffff2e]" />
                      <span className="w-[150px] shrink-0 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)]">
                        {t.id}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--sf-text-3)]">
                        {t.goal}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="flex w-full flex-col gap-2 px-5 pb-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                Pipeline
              </span>
              <span className="font-sans text-[11px] text-[var(--sf-text-3)]">
                Averages from the last 20 runs
              </span>
            </div>
            <div className="flex w-full snap-x snap-mandatory gap-2.5 overflow-x-auto pb-1">
              {form.pipelines.map((p) => (
                <PipelineRunCard
                  key={p.path}
                  className="w-[220px] shrink-0 snap-start"
                  pipeline={p}
                  runs={snapshot.runs}
                  selected={form.pipeline === p.path}
                  onSelect={() => form.setPipeline(p.path)}
                />
              ))}
            </div>
          </section>

          <section className="flex w-full flex-col gap-2.5 px-5 pb-4">
            <div className="flex h-10 w-full items-center gap-2.5 rounded-[10px] border border-[#ffffff12] px-3 py-0">
              <LuChevronRight className="size-3.5 shrink-0 text-[var(--sf-text-2)]" aria-hidden="true" />
              <span className="shrink-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
                Advanced
              </span>
              <span className="min-w-0 flex-1 truncate font-sans text-xs text-[var(--sf-text-3)]">
                Model override · Checkout branch
              </span>
              <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                use CLI for overrides
              </span>
            </div>
          </section>
        </div>

        <div className="flex w-full shrink-0 flex-col border-t border-t-[#ffffff12] bg-[#101114]">
          <div className="flex flex-col gap-2 px-5 pb-3 pt-3">
            <div className="flex flex-col gap-2 rounded-[10px] border border-[#ffffff12] bg-[#0f1013] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-5">
                <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  Ready
                </span>
                <ReadinessCheck
                  ok={form.providerReady === true}
                  pending={form.providerReady === null}
                  label="Provider"
                  detail={
                    form.providerReady === true
                      ? "connected"
                      : form.providerReady === false
                        ? "not ready"
                        : "checking…"
                  }
                />
                <ReadinessCheck
                  ok={form.pipelineValidation === "valid"}
                  pending={form.pipelineValidation === "checking"}
                  fail={form.pipelineValidation === "invalid"}
                  label="Pipeline valid"
                  detail={
                    form.pipelineValidation === "valid"
                      ? "(strict)"
                      : form.pipelineValidation === "invalid"
                        ? "invalid"
                        : form.pipelineValidation === "checking"
                          ? "…"
                          : ""
                  }
                />
              </div>
              {form.authGateMessage ? (
                <p className="font-sans text-xs text-[var(--sf-fail)]">
                  {form.authGateMessage}{" "}
                  <a href="#/settings" className="text-[var(--sf-running)]">
                    Settings
                  </a>
                </p>
              ) : null}
              {form.pipelineValidationDetail && form.pipelineValidation === "invalid" ? (
                <p className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-fail)]">
                  {form.pipelineValidationDetail}
                </p>
              ) : null}
              {slotsLabel ? (
                <div className="flex items-center gap-2 border-t border-t-[#ffffff12] pt-2">
                  <LuCircleAlert className="size-3.5 shrink-0 text-[var(--sf-text-2)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1 font-sans text-[13px] text-[var(--sf-text-2)]">
                    {slotsLabel}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="flex h-8 w-full items-center gap-2 rounded-lg border border-[#ffffff12] bg-[var(--sf-ground)] px-2.5 py-0">
              <LuTerminal className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden="true" />
              <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                $
              </span>
              <code className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
                {form.cliLine}
              </code>
              <button
                type="button"
                className="flex h-[22px] shrink-0 items-center gap-[5px] rounded-md px-1.5 py-0"
                onClick={() => void copyCli()}
              >
                <LuCopy className="size-[13px] text-[var(--sf-text-3)]" aria-hidden="true" />
                <span className="font-sans text-xs text-[var(--sf-text-3)]">Copy</span>
              </button>
            </div>

            {form.startFailure ? (
              <p className="font-sans text-[13px] text-[var(--sf-fail)]" role="alert">
                {form.startFailure.error}
              </p>
            ) : null}
            {form.displayError ? (
              <p className="font-sans text-[13px] text-[var(--sf-fail)]" role="alert">
                {form.displayError}
              </p>
            ) : null}
          </div>

        <footer className="flex w-full shrink-0 items-center gap-2 border-t border-t-[#ffffff12] px-5 py-3.5">
          <span className="min-w-0 flex-1 font-sans text-xs text-[var(--sf-text-3)]">
            New run id is assigned on start. You can watch it in Runs.
          </span>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg px-3 py-0"
            onClick={onClose}
          >
            <span className="font-sans text-[13px] font-medium text-[var(--sf-text-2)]">
              Cancel
            </span>
            <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
              esc
            </span>
          </button>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-3 py-0 disabled:opacity-50"
            disabled={!form.canStart || form.catalogLoading}
            onClick={() => void form.submit()}
          >
            <LuPlay className="size-[13px] text-[var(--sf-ground)]" aria-hidden="true" />
            <span className="font-sans text-[13px] font-medium text-[var(--sf-ground)]">
              {form.starting ? "Starting…" : "Start run"}
            </span>
            <span className="font-['Geist_Mono',monospace] text-[11px] text-[#5a5e66]">
              ⌘↵
            </span>
          </button>
        </footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ReadinessCheck({
  ok,
  pending,
  fail,
  label,
  detail,
}: {
  ok?: boolean;
  pending?: boolean;
  fail?: boolean;
  label: string;
  detail?: string;
}) {
  const color = ok
    ? "text-[var(--sf-ok)]"
    : fail
      ? "text-[var(--sf-fail)]"
      : pending
        ? "text-[var(--sf-text-3)]"
        : "text-[var(--sf-text-3)]";
  return (
    <span className="flex items-center gap-1.5">
      {ok ? (
        <LuCheck className="size-3.5 text-[var(--sf-ok)]" aria-hidden="true" />
      ) : (
        <span className={`size-3.5 rounded-full border border-[#ffffff2e] ${pending ? "animate-pulse" : ""}`} />
      )}
      <span className="font-sans text-[13px] text-[var(--sf-text-1)]">{label}</span>
      {detail ? (
        <span className={`font-['Geist_Mono',monospace] text-xs ${color}`}>{detail}</span>
      ) : null}
    </span>
  );
}
