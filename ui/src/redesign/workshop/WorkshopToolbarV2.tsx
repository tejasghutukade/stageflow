import { useRef, useState, type KeyboardEvent } from "react";
import { LuLoader, LuLoaderCircle, LuPencil, LuSave, LuX } from "react-icons/lu";
import { Keycap } from "../Keycap";
import { formatAgo, useNow, type TimeInput } from "./relativeTime";

export type WorkshopSaveState = "new" | "dirty" | "clean";

export type WorkshopToolbarV2Props = {
  title: string;
  untitled: boolean;
  saveState: WorkshopSaveState;
  changeCount: number;
  autosavedAt: TimeInput | null;
  autoApply: boolean;
  onAutoApplyChange: (on: boolean) => void;
  onRename: (id: string) => void;
  stageCount: number;
  errorCount: number;
  validateBusy: boolean;
  onValidate: () => void;
  hasDestination: boolean;
  saving: boolean;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveInvalid: () => void;
  onErrorsClick?: () => void;
};

const MONO = "font-['Geist_Mono',monospace]";

function errorsLabel(count: number): string {
  return `${count} ${count === 1 ? "error" : "errors"}`;
}

function StateChip({ saveState, changeCount }: { saveState: WorkshopSaveState; changeCount: number }) {
  if (saveState === "new") {
    return (
      <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-[#ffffff26] px-2">
        <LuLoader className="size-3 text-[#a7aab2]" aria-hidden />
        <span className="whitespace-nowrap text-xs font-medium text-[#a7aab2]">not saved yet</span>
      </span>
    );
  }
  const label =
    saveState === "clean"
      ? "saved"
      : changeCount > 0
        ? `draft · ${changeCount} ${changeCount === 1 ? "change" : "changes"}`
        : "draft";
  return (
    <span
      className={`flex h-5 shrink-0 items-center whitespace-nowrap rounded-full border border-[#ffffff1a] bg-[#1a1c21] px-[7px] ${MONO} text-[11px] text-[#a7aab2]`}
    >
      {label}
    </span>
  );
}

function DraftTitle({
  title,
  untitled,
  isNewDraft,
  onRename,
}: {
  title: string;
  untitled: boolean;
  isNewDraft: boolean;
  onRename: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const doneRef = useRef(false);

  const showUntitled = untitled || !title.trim();
  const displayTitle = showUntitled ? "Untitled draft" : title;

  const start = () => {
    doneRef.current = false;
    setValue(showUntitled ? "" : title);
    setEditing(true);
  };

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const next = value.trim();
    if (!commit || !next) return;
    if (showUntitled || next !== title) onRename(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        aria-label="Pipeline id"
        value={value}
        placeholder="pipeline-id"
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        onFocus={(event) => event.currentTarget.select()}
        className={`h-[30px] w-[240px] min-w-0 rounded-md border border-[#ffffff33] bg-[#1a1c21] px-2 ${MONO} text-sm font-medium tracking-[-0.14px] text-[#ecedee] shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)] outline-none placeholder:text-[#8b8f98]`}
      />
    );
  }

  if (isNewDraft) {
    return (
      <button
        type="button"
        onClick={start}
        title="Rename draft"
        className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-dashed border-[#ffffff1a] px-2 hover:border-[#ffffff33]"
      >
        <span
          className={
            showUntitled
              ? "whitespace-nowrap font-sans text-[15px] font-semibold tracking-[-0.15px] text-[#ecedee]"
              : `min-w-0 max-w-[320px] truncate ${MONO} text-sm font-medium tracking-[-0.14px] text-[#ecedee]`
          }
        >
          {displayTitle}
        </span>
        <LuPencil className="size-3 text-[#8b8f98]" aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      title="Rename pipeline"
      className="group/title -mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 hover:bg-[#ffffff0a]"
    >
      <span
        className={`min-w-0 max-w-[320px] truncate ${MONO} text-sm font-medium tracking-[-0.14px] text-[#ecedee]`}
      >
        {displayTitle}
      </span>
      <LuPencil
        className="size-3 shrink-0 text-[#8b8f98] opacity-0 group-hover/title:opacity-100"
        aria-hidden
      />
    </button>
  );
}

function AutosaveLine({ at, onDisk }: { at: TimeInput; onDisk: boolean }) {
  const now = useNow(5000);
  return (
    <span className="whitespace-nowrap font-sans text-[11px] text-[#8b8f98]">
      Autosaved {formatAgo(at, now)}
      {onDisk ? "" : " · not on disk"}
    </span>
  );
}

export function WorkshopToolbarV2({
  title,
  untitled,
  saveState,
  changeCount,
  autosavedAt,
  autoApply,
  onAutoApplyChange,
  onRename,
  stageCount,
  errorCount,
  validateBusy,
  onValidate,
  hasDestination,
  saving,
  onSave,
  onSaveAs,
  onSaveInvalid,
  onErrorsClick,
}: WorkshopToolbarV2Props) {
  const empty = stageCount === 0;
  const validateDisabled = empty || validateBusy;
  const saveDisabled = empty || saving;
  const showSaveTooltip = errorCount > 0 && !saveDisabled;

  const errorPillClass =
    "flex h-6 shrink-0 items-center gap-1 rounded-full border border-[#f2645a47] bg-[#f2645a1a] px-2";
  const errorPillBody = (
    <>
      <LuX className="size-3 text-[#f2645a]" aria-hidden />
      <span className="whitespace-nowrap font-sans text-xs font-medium text-[#f2645a]">
        {errorsLabel(errorCount)}
      </span>
    </>
  );

  return (
    <header className="relative flex h-[52px] w-full shrink-0 items-center gap-1.5 border-b border-b-[#ffffff12] bg-[#0c0d0f] px-3.5">
      <div className="flex min-w-0 shrink flex-col justify-center gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <DraftTitle
            title={title}
            untitled={untitled}
            isNewDraft={saveState === "new"}
            onRename={onRename}
          />
          <StateChip saveState={saveState} changeCount={changeCount} />
        </div>
        {autosavedAt !== null ? (
          <AutosaveLine at={autosavedAt} onDisk={saveState === "clean"} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1" />
      <button
        type="button"
        role="switch"
        aria-checked={autoApply}
        onClick={() => onAutoApplyChange(!autoApply)}
        className="flex shrink-0 items-center gap-[7px] rounded-md py-1 pr-1"
      >
        <span
          className={`flex h-4 w-[26px] items-center rounded-full px-0.5 transition-colors ${
            autoApply ? "bg-[#ecedee]" : "bg-[#2a2d33]"
          }`}
        >
          <span
            className={`block size-3 rounded-full transition-transform ${
              autoApply ? "translate-x-[10px] bg-[#0c0d0f]" : "bg-[#8b8f98]"
            }`}
          />
        </span>
        <span className="whitespace-nowrap font-sans text-xs text-[#a7aab2]">
          Auto-apply chat edits
        </span>
      </button>
      <div className="h-5 w-px shrink-0 bg-[#ffffff12]" />
      <div className="group relative shrink-0">
        <button
          type="button"
          disabled={validateDisabled}
          onClick={onValidate}
          className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 ${
            empty
              ? "cursor-not-allowed border-[#ffffff0d] bg-[#131418]"
              : "border-[#ffffff1a] bg-[#1a1c21] enabled:hover:bg-[#202228]"
          }`}
        >
          {validateBusy ? (
            <LuLoaderCircle className="size-3.5 animate-spin text-[#a7aab2]" aria-hidden />
          ) : null}
          <span
            className={`whitespace-nowrap font-sans text-[13px] font-medium ${
              empty ? "text-[#8b8f98]" : "text-[#ecedee]"
            }`}
          >
            {validateBusy ? "Validating…" : "Validate"}
          </span>
          {validateBusy ? null : <Keycap>V</Keycap>}
        </button>
        {empty ? (
          <div className="pointer-events-none absolute right-0 top-[38px] z-10 hidden h-6 items-center whitespace-nowrap rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-2 font-sans text-[11px] text-[#a7aab2] shadow-[0px_8px_24px_rgba(0,0,0,0.5)] group-hover:flex">
            nothing to validate
          </div>
        ) : null}
      </div>
      {hasDestination ? (
        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSaveAs}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 ${
            saveDisabled
              ? "cursor-not-allowed border-[#ffffff0d] bg-[#131418]"
              : "border-[#ffffff1a] bg-[#1a1c21] hover:bg-[#202228]"
          }`}
        >
          <span
            className={`whitespace-nowrap font-sans text-[13px] font-medium ${
              saveDisabled ? "text-[#8b8f98]" : "text-[#ecedee]"
            }`}
          >
            Save As…
          </span>
        </button>
      ) : null}
      {errorCount > 0 ? (
        onErrorsClick ? (
          <button type="button" onClick={onErrorsClick} className={`${errorPillClass} hover:bg-[#f2645a26]`}>
            {errorPillBody}
          </button>
        ) : (
          <span className={errorPillClass}>{errorPillBody}</span>
        )
      ) : null}
      <div className="group relative shrink-0">
        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSave}
          className={`flex h-8 items-center rounded-lg px-3 ${
            empty
              ? "cursor-not-allowed gap-2 bg-[#2a2d33]"
              : "gap-1.5 bg-[#ecedee] enabled:hover:bg-white"
          }`}
        >
          {saving ? (
            <LuLoaderCircle className="size-3.5 animate-spin text-[#0c0d0f]" aria-hidden />
          ) : empty ? (
            <LuSave className="size-3.5 text-[#8b8f98]" aria-hidden />
          ) : null}
          <span
            className={`whitespace-nowrap font-sans text-[13px] font-medium ${
              empty ? "text-[#8b8f98]" : "text-[#0c0d0f]"
            }`}
          >
            {saving ? "Saving…" : hasDestination ? "Save" : "Save…"}
          </span>
          {saving ? null : (
            <span className={`${MONO} text-[11px] ${empty ? "text-[#8b8f98]" : "text-[#5a5e66]"}`}>
              ⌘S
            </span>
          )}
        </button>
        {showSaveTooltip ? (
          <div className="absolute right-0 top-full z-10 hidden pt-1.5 group-focus-within:block group-hover:block">
            <div className="flex flex-col items-start gap-px whitespace-nowrap rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-2 py-[5px] shadow-[0px_6px_16px_rgba(0,0,0,0.45)]">
              <span className="font-sans text-[11px] text-[#a7aab2]">
                Fix {errorsLabel(errorCount)} or
              </span>
              <button
                type="button"
                onClick={onSaveInvalid}
                className="font-sans text-[11px] font-medium text-[#ecedee] underline decoration-[#ffffff40] underline-offset-2 hover:decoration-[#ecedee]"
              >
                save invalid anyway
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
