import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuCheck,
  LuChevronDown,
  LuCircleAlert,
  LuCircleCheck,
  LuFile,
  LuFolder,
  LuGitBranch,
  LuInfo,
  LuLink2,
  LuLoaderCircle,
  LuSave,
  LuWrench,
  LuX,
} from "react-icons/lu";
import type {
  DraftPackagePayload,
  DraftValidationResult,
  ValidationFinding,
} from "../../../api";
import { Keycap } from "../../Keycap";
import {
  canSave,
  fallbackRows,
  footerHint,
  pipelineIdHint,
  planRows,
  planSummary,
  unrewrittenStagesFootnote,
  validationView,
  type DraftPlanResult,
  type SaveDialogMode,
  type SavePlanRow,
} from "./savePlanView";

export type SaveDestination = { root: string; pipelineId: string };

export type SaveToCatalogDialogV2Props = {
  open: boolean;
  draft: DraftPackagePayload;
  roots: Array<{ value: string; label: string }>;
  initialRoot: string;
  initialPipelineId: string;
  mode: SaveDialogMode;
  plan: DraftPlanResult | null;
  planLoading: boolean;
  validation: DraftValidationResult | null;
  allowInvalidInitial?: boolean;
  saving: boolean;
  error?: string | null;
  title?: string;
  onChangeDestination: (destination: SaveDestination) => void;
  onSave: (allowInvalid: boolean, destination: SaveDestination) => void;
  onSaveAs?: (destination: SaveDestination) => void;
  onCancel: () => void;
  onFixInWorkshop: (finding: ValidationFinding) => void;
};

const MONO = "font-['Geist_Mono',monospace]";
const SECTION_LABEL =
  "font-sans text-[11px] font-medium uppercase tracking-[0.88px] text-[#8b8f98]";
const MAX_VALIDATION_LINES = 3;
const ID_DEBOUNCE_MS = 250;

function FileRow({ row }: { row: SavePlanRow }) {
  const hasMarker = row.errorCount > 0 || row.taskAttached;
  return (
    <div
      className={`flex h-[38px] w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff0d] px-3 last:border-b-0 ${
        row.errorCount > 0 ? "bg-[#f2645a0a]" : ""
      }`}
    >
      <LuFile
        className={`size-4 shrink-0 ${row.muted ? "text-[#8b8f98]" : "text-[#ecedee]"}`}
        aria-hidden
      />
      <span
        title={row.path}
        className={`min-w-0 truncate ${MONO} text-xs ${hasMarker ? "" : "flex-1"} ${
          row.muted ? "text-[#8b8f98] line-through decoration-[#8b8f98]" : "text-[#ecedee]"
        }`}
      >
        {row.path}
      </span>
      {hasMarker ? (
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          {row.errorLabel ? (
            <span className="flex shrink-0 items-center gap-1">
              <LuCircleAlert className="size-3 text-[#f2645a]" aria-hidden />
              <span className="whitespace-nowrap font-sans text-[11px] text-[#f2645a]">{row.errorLabel}</span>
            </span>
          ) : null}
          {row.taskAttached ? (
            <span className="flex shrink-0 items-center gap-1">
              <LuLink2 className="size-3 text-[#a7aab2]" aria-hidden />
              <span className="whitespace-nowrap font-sans text-[11px] text-[#a7aab2]">task attached</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {row.action === "overwrite" ? (
        <span className={`flex shrink-0 items-center gap-1.5 ${MONO} text-[11px]`}>
          <span className="text-[#4cc38a]">+{row.added}</span>
          <span className="text-[#f2645a]">−{row.removed}</span>
        </span>
      ) : null}
      {row.statusLabel ? (
        row.statusPill ? (
          <span
            className={`flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-full border bg-[#1a1c21] px-2 font-sans text-[11px] font-medium text-[#ecedee] ${
              row.action === "overwrite" ? "border-[#ffffff26]" : "border-[#ffffff1a]"
            }`}
          >
            {row.statusLabel}
          </span>
        ) : (
          <span className="shrink-0 whitespace-nowrap font-sans text-[11px] text-[#8b8f98]">
            {row.statusLabel}
          </span>
        )
      ) : null}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex h-[38px] w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff0d] px-3 last:border-b-0">
      <span className="block size-4 shrink-0 animate-pulse rounded-sm bg-[#ffffff0d]" />
      <span className="block h-2.5 w-[45%] animate-pulse rounded-full bg-[#ffffff0d]" />
      <span className="min-w-0 flex-1" />
      <span className="block h-[22px] w-14 animate-pulse rounded-full bg-[#ffffff0d]" />
    </div>
  );
}

function DialogBody({
  draft,
  roots,
  initialRoot,
  initialPipelineId,
  mode,
  plan,
  planLoading,
  validation,
  allowInvalidInitial,
  saving,
  error,
  title = "Save to catalog",
  onChangeDestination,
  onSave,
  onSaveAs,
  onCancel,
  onFixInWorkshop,
}: Omit<SaveToCatalogDialogV2Props, "open">) {
  const [root, setRoot] = useState(initialRoot);
  const [pipelineId, setPipelineId] = useState(initialPipelineId);
  const [allowInvalid, setAllowInvalid] = useState(Boolean(allowInvalidInitial));
  const sentRef = useRef<SaveDestination>({ root: initialRoot, pipelineId: initialPipelineId });
  const changeRef = useRef(onChangeDestination);
  changeRef.current = onChangeDestination;

  const sendDestination = (next: SaveDestination) => {
    const sent = sentRef.current;
    if (sent.root === next.root && sent.pipelineId === next.pipelineId) return;
    sentRef.current = next;
    changeRef.current(next);
  };

  const sendRef = useRef(sendDestination);
  sendRef.current = sendDestination;

  useEffect(() => {
    const id = window.setTimeout(
      () => sendRef.current({ root, pipelineId: pipelineId.trim() }),
      ID_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [pipelineId, root]);

  const destination = (): SaveDestination => {
    const next = { root, pipelineId: pipelineId.trim() };
    sendDestination(next);
    return next;
  };

  const findings = useMemo(() => validation?.findings ?? [], [validation]);
  const view = useMemo(() => validationView(validation), [validation]);
  const rows = useMemo(
    () => (plan ? planRows(plan, draft, findings) : fallbackRows(draft, root, pipelineId, findings)),
    [draft, findings, pipelineId, plan, root],
  );
  const footnote = useMemo(() => unrewrittenStagesFootnote(draft), [draft]);
  const hint = pipelineIdHint({ pipelineId, initialPipelineId, mode, plan, planLoading });
  const enabled = canSave({ validation: view, allowInvalid, saving, pipelineId });
  const failed = view.status === "failed";

  const rootOptions = roots.some((option) => option.value === root)
    ? roots
    : [{ value: root, label: root || "." }, ...roots];

  const submit = () => {
    if (!enabled) return;
    onSave(failed && allowInvalid, destination());
  };

  const submitRef = useRef(submit);
  submitRef.current = submit;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!savingRef.current) cancelRef.current();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center bg-[#040506a8] px-4 pt-[104px] font-sans"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-save-dialog-title"
        className="flex max-h-[calc(100vh-136px)] w-[680px] min-w-0 max-w-full flex-col overflow-clip rounded-[14px] border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
      >
        <div className="flex w-full shrink-0 items-start gap-3 px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2
              id="sf-save-dialog-title"
              className="text-[17px] font-semibold tracking-[-0.17px] text-[#ecedee]"
            >
              {title}
            </h2>
            <p className="text-[13px] text-[#a7aab2]">Writes these files after validation passes.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <Keycap className="bg-[#1a1c21]">esc</Keycap>
            <button
              type="button"
              aria-label="Close"
              disabled={saving}
              onClick={onCancel}
              className="flex size-7 items-center justify-center rounded-lg hover:bg-[#ffffff0a]"
            >
              <LuX className="size-4 text-[#8b8f98]" aria-hidden />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex w-full flex-col gap-2 px-5 pb-4">
            <span className={SECTION_LABEL}>Destination</span>
            <div className="flex w-full gap-2.5">
              <label className="flex w-[260px] shrink-0 flex-col gap-1.5">
                <span className="text-xs text-[#a7aab2]">Catalog root</span>
                <span className="relative flex h-[34px] items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 focus-within:border-[#ffffff33] focus-within:shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]">
                  <LuFolder className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                  <select
                    value={root}
                    disabled={saving}
                    onChange={(event) => {
                      setRoot(event.target.value);
                      sendDestination({ root: event.target.value, pipelineId: pipelineId.trim() });
                    }}
                    className={`min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent pr-5 ${MONO} text-xs text-[#ecedee] outline-none`}
                  >
                    {rootOptions.map((option) => (
                      <option key={option.value} value={option.value} className="bg-[#1a1c21]">
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <LuChevronDown
                    className="pointer-events-none absolute right-2.5 size-3.5 text-[#8b8f98]"
                    aria-hidden
                  />
                </span>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs text-[#a7aab2]">Pipeline id</span>
                <span className="flex h-[34px] items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 focus-within:border-[#ffffff33] focus-within:shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]">
                  <LuGitBranch className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                  <input
                    autoFocus
                    value={pipelineId}
                    disabled={saving}
                    spellCheck={false}
                    onChange={(event) => setPipelineId(event.target.value)}
                    className={`min-w-0 flex-1 bg-transparent ${MONO} text-xs text-[#ecedee] caret-[#ecedee] outline-none`}
                  />
                  {hint ? (
                    <span
                      className={`shrink-0 whitespace-nowrap text-[11px] ${
                        hint.tone === "warn" ? "text-[#f5b544]" : "text-[#8b8f98]"
                      }`}
                    >
                      {hint.text}
                    </span>
                  ) : null}
                </span>
              </label>
            </div>
          </div>

          <div className="flex w-full flex-col gap-2 px-5 pb-4">
            <div className="flex items-center justify-between">
              <span className={SECTION_LABEL}>Files to write</span>
              <span className={`${MONO} text-[11px] text-[#8b8f98]`}>
                {planLoading ? "planning…" : plan ? planSummary(plan) : ""}
              </span>
            </div>
            <div className="flex max-h-[230px] w-full min-w-0 flex-col overflow-y-auto rounded-[10px] border border-[#ffffff12] bg-[#0f1013]">
              {planLoading
                ? [0, 1, 2, 3].map((index) => <SkeletonRow key={index} />)
                : rows.map((row) => <FileRow key={row.path} row={row} />)}
            </div>
            {footnote ? (
              <p className="text-[11px] leading-[1.4] text-[#8b8f98]">{footnote}</p>
            ) : null}
          </div>

          {view.status !== "none" ? (
            <div className="flex w-full flex-col gap-2 px-5 pb-[18px]">
              {view.status === "failed" ? (
                <>
                  <div className="flex w-full flex-col gap-2 rounded-[10px] border border-[#f2645a47] bg-[#f2645a0f] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <LuCircleAlert className="size-4 text-[#f2645a]" aria-hidden />
                      <span className="whitespace-nowrap text-[13px] font-medium text-[#f2645a]">
                        {view.title}
                      </span>
                      <span className="flex-1" />
                      <span className={`whitespace-nowrap ${MONO} text-[11px] text-[#8b8f98]`}>
                        sf validate --strict
                      </span>
                    </div>
                    {view.lines.slice(0, MAX_VALIDATION_LINES).map((line, index) => (
                      <div key={`${line.location}:${index}`} className="flex h-[30px] items-center gap-2 pl-6">
                        <span className={`shrink-0 whitespace-nowrap ${MONO} text-xs text-[#ecedee]`}>
                          {line.location}:
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate ${MONO} text-xs text-[#a7aab2]`}
                          title={line.message}
                        >
                          {line.message}
                        </span>
                        <button
                          type="button"
                          onClick={() => onFixInWorkshop(line.finding)}
                          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 hover:bg-[#ffffff0a]"
                        >
                          <LuWrench className="size-3.5 text-[#a7aab2]" aria-hidden />
                          <span className="whitespace-nowrap text-xs font-medium text-[#ecedee]">
                            Fix in Workshop
                          </span>
                        </button>
                      </div>
                    ))}
                    {view.lines.length > MAX_VALIDATION_LINES ? (
                      <span className="pl-6 text-[11px] text-[#8b8f98]">
                        +{view.lines.length - MAX_VALIDATION_LINES} more in the Problems tab
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={allowInvalid}
                    disabled={saving}
                    onClick={() => setAllowInvalid((value) => !value)}
                    className="flex w-full items-start gap-2.5 rounded-[10px] border border-[#ffffff12] px-3 py-2.5 text-left hover:bg-[#ffffff05]"
                  >
                    <span
                      className={`mt-px flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                        allowInvalid ? "border-[#ecedee] bg-[#ecedee]" : "border-[#ffffff40] bg-[#1a1c21]"
                      }`}
                    >
                      {allowInvalid ? <LuCheck className="size-3 text-[#0c0d0f]" aria-hidden /> : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13px] font-medium text-[#ecedee]">Save invalid anyway</span>
                      <span className="text-xs leading-[1.45] text-[#8b8f98]">
                        Writes the YAML as-is. sf validate will fail until you fix it.
                      </span>
                    </span>
                  </button>
                </>
              ) : (
                <div className="flex w-full items-center gap-2 rounded-[10px] border border-[#4cc38a47] bg-[#4cc38a0f] px-3 py-2.5">
                  <LuCircleCheck className="size-4 text-[#4cc38a]" aria-hidden />
                  <span className="whitespace-nowrap text-[13px] font-medium text-[#4cc38a]">{view.title}</span>
                  <span className="flex-1" />
                  <span className={`whitespace-nowrap ${MONO} text-[11px] text-[#8b8f98]`}>
                    sf validate --strict
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex w-full shrink-0 items-center gap-2 border-t border-t-[#ffffff12] bg-[#101114] px-5 py-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {error ? (
              <>
                <LuCircleAlert className="size-3.5 shrink-0 text-[#f2645a]" aria-hidden />
                <span className="truncate text-xs text-[#f2645a]" title={error}>
                  {error}
                </span>
              </>
            ) : (
              <>
                <LuInfo className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                <span className="truncate text-xs text-[#8b8f98]">
                  {footerHint({ validation: view, allowInvalid, plan })}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 hover:bg-[#ffffff0a]"
          >
            <span className="text-[13px] font-medium text-[#a7aab2]">Cancel</span>
            <span className={`${MONO} text-[11px] text-[#8b8f98]`}>esc</span>
          </button>
          {onSaveAs && mode === "overwrite" ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => onSaveAs(destination())}
              className="flex h-8 shrink-0 items-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 hover:bg-[#202228]"
            >
              <span className="whitespace-nowrap text-[13px] font-medium text-[#ecedee]">Save As…</span>
            </button>
          ) : null}
          <button
            type="button"
            disabled={!enabled}
            onClick={submit}
            className={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 ${
              enabled || saving ? "bg-[#ecedee] enabled:hover:bg-white" : "cursor-not-allowed bg-[#2a2d33]"
            }`}
          >
            {saving ? (
              <LuLoaderCircle className="size-3.5 animate-spin text-[#0c0d0f]" aria-hidden />
            ) : (
              <LuSave className={`size-3.5 ${enabled ? "text-[#0c0d0f]" : "text-[#8b8f98]"}`} aria-hidden />
            )}
            <span
              className={`text-[13px] font-medium ${enabled || saving ? "text-[#0c0d0f]" : "text-[#8b8f98]"}`}
            >
              {saving ? "Saving…" : "Save"}
            </span>
            {saving ? null : (
              <span className={`${MONO} text-[11px] ${enabled ? "text-[#5a5e66]" : "text-[#8b8f98]"}`}>
                ⌘⏎
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SaveToCatalogDialogV2({ open, ...props }: SaveToCatalogDialogV2Props) {
  if (!open) return null;
  return <DialogBody {...props} />;
}
