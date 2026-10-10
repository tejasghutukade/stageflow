import {
  LuCheck,
  LuCircleX,
  LuFileCode,
  LuHammer,
  LuPlay,
  LuTriangleAlert,
  LuWandSparkles,
} from "react-icons/lu";
import { Keycap } from "../Keycap";
import type { HeaderPills } from "./editorHeaderModel";

export type PipelineEditorTabId = "editor" | "runs" | "history";

export type PipelineEditorHeaderProps = {
  pipelineId: string;
  filePath: string;
  unsavedCount: number;
  pills: HeaderPills | null;
  discardDisabled: boolean;
  saveDisabled: boolean;
  saving: boolean;
  workshopHref: string;
  onDiscard(): void;
  onStartRun(): void;
  onSave(): void;
  onCopyPath(): void;
  activeTab: PipelineEditorTabId;
  onTabChange(tab: PipelineEditorTabId): void;
  runsCount: number | null;
  autoValidate: boolean;
  onAutoValidateChange(next: boolean): void;
  onFormat(): void;
  formatDisabled: boolean;
};

const actionBtn =
  "flex h-8 shrink-0 items-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 font-sans text-[13px] font-medium text-[#ecedee] hover:bg-[#ffffff08] disabled:cursor-default disabled:opacity-50";

function tabClass(active: boolean): string {
  return [
    "flex h-[38px] shrink-0 items-center border-b-2 font-sans text-[13px] leading-normal",
    active
      ? "border-b-[#ecedee] font-medium text-[#ecedee]"
      : "border-b-transparent text-[#a7aab2] hover:text-[#ecedee]",
  ].join(" ");
}

export function PipelineEditorHeader({
  pipelineId,
  filePath,
  unsavedCount,
  pills,
  discardDisabled,
  saveDisabled,
  saving,
  workshopHref,
  onDiscard,
  onStartRun,
  onSave,
  onCopyPath,
  activeTab,
  onTabChange,
  runsCount,
  autoValidate,
  onAutoValidateChange,
  onFormat,
  formatDisabled,
}: PipelineEditorHeaderProps) {
  return (
    <div className="flex h-fit w-full shrink-0 flex-col border-b border-b-[#ffffff12]">
      <div className="flex h-16 w-full items-center gap-4 px-5 py-0">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex items-center gap-1.5">
            <a
              href="#/pipelines"
              className="text-xs leading-normal text-[#8b8f98] hover:text-[#ecedee]"
            >
              Pipelines
            </a>
            <span className="text-xs leading-normal text-[#8b8f98]">/</span>
            <span className="text-xs leading-normal text-[#a7aab2]">
              {pipelineId}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="shrink-0 text-xl font-semibold leading-[1.2] tracking-[-0.4px] text-[#ecedee]">
              {pipelineId}
            </h1>
            <button
              type="button"
              onClick={onCopyPath}
              title={filePath}
              className="flex h-[22px] max-w-full min-w-0 shrink items-center gap-[5px] rounded-md border border-[#ffffff12] bg-[#131418] px-[7px] hover:bg-[#ffffff08]"
            >
              <LuFileCode
                className="size-3 shrink-0 text-[#8b8f98]"
                aria-hidden
              />
              <span className="truncate font-['Geist_Mono',monospace] text-xs leading-normal text-[#a7aab2]">
                {filePath}
              </span>
            </button>
            {unsavedCount > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span
                  className="size-1.5 rounded-full bg-[#ecedee]"
                  aria-hidden
                />
                <span className="text-xs leading-normal text-[#8b8f98]">
                  {unsavedCount} unsaved
                </span>
              </span>
            ) : null}
          </div>
        </div>
        {pills ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={`flex h-6 items-center gap-[5px] rounded-full px-2 ${
                pills.strictOk
                  ? "bg-[#4cc38a1a] text-[#4cc38a]"
                  : "bg-[#e5484d1a] text-[#e5484d]"
              }`}
            >
              {pills.strictOk ? (
                <LuCheck className="size-3 shrink-0" aria-hidden />
              ) : (
                <LuCircleX className="size-3 shrink-0" aria-hidden />
              )}
              <span className="font-sans text-xs font-medium">
                {pills.strictLabel}
              </span>
            </span>
            {pills.warningCount > 0 ? (
              <span className="flex h-6 items-center gap-[5px] rounded-full bg-[#a7aab21a] px-2 text-[#a7aab2]">
                <LuTriangleAlert className="size-3 shrink-0" aria-hidden />
                <span className="font-sans text-xs font-medium">
                  {pills.warningLabel}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="block h-5 w-px shrink-0 bg-[#ffffff12]" aria-hidden />
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={actionBtn}
            disabled={discardDisabled}
            onClick={onDiscard}
          >
            Discard
          </button>
          <a href={workshopHref} className={`${actionBtn} gap-1.5`}>
            <LuHammer className="size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
            Open in Workshop
          </a>
          <button
            type="button"
            className={`${actionBtn} gap-1.5`}
            onClick={onStartRun}
          >
            <LuPlay className="size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
            Start a run
          </button>
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[#ecedee] px-3 font-sans text-[13px] font-medium text-[#0c0d0f] hover:bg-white disabled:cursor-default disabled:opacity-50"
            disabled={saveDisabled}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
            <Keycap className="border-[#0c0d0f2e] text-[#4a4d55]">⌘S</Keycap>
          </button>
        </div>
      </div>
      <div className="flex h-[38px] w-full items-end gap-5 px-5 py-0" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "editor"}
          className={tabClass(activeTab === "editor")}
          onClick={() => onTabChange("editor")}
        >
          Editor
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "runs"}
          className={`${tabClass(activeTab === "runs")} gap-1.5`}
          onClick={() => onTabChange("runs")}
        >
          Runs
          {runsCount != null ? (
            <span className="rounded-sm bg-[#1a1c21] px-[5px] font-['Geist_Mono',monospace] text-[11px] leading-[1.45455] text-[#a7aab2]">
              {runsCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "history"}
          className={tabClass(activeTab === "history")}
          onClick={() => onTabChange("history")}
        >
          History
        </button>
        <div className="block flex-1" aria-hidden />
        {activeTab === "editor" ? (
          <div className="flex h-[38px] items-center gap-3.5">
            <button
              type="button"
              role="switch"
              aria-checked={autoValidate}
              aria-label="Validate as you type"
              className="flex items-center gap-1.5 hover:text-[#ecedee]"
              onClick={() => onAutoValidateChange(!autoValidate)}
            >
              <span
                className={`flex h-3.5 w-6 items-center rounded-full px-0.5 ${
                  autoValidate
                    ? "justify-end bg-[#ecedee]"
                    : "justify-start bg-[#1a1c21]"
                }`}
              >
                <span
                  className={`size-2.5 rounded-full ${
                    autoValidate ? "bg-[#0c0d0f]" : "bg-[#8b8f98]"
                  }`}
                />
              </span>
              <span className="text-xs leading-normal text-[#a7aab2]">
                Validate as you type
              </span>
            </button>
            <button
              type="button"
              className="flex items-center gap-[5px] hover:text-[#ecedee] disabled:cursor-default disabled:opacity-50"
              disabled={formatDisabled}
              onClick={onFormat}
            >
              <LuWandSparkles
                className="size-[13px] shrink-0 text-[#8b8f98]"
                aria-hidden
              />
              <span className="text-xs leading-normal text-[#a7aab2]">
                Format
              </span>
              <Keycap className="border-[#ffffff1a] bg-[#1a1c21] text-[#8b8f98]">
                ⇧⌥F
              </Keycap>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
