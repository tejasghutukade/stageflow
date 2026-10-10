import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  fetchPipelines,
  fetchSkills,
  fetchSkillUsage,
  type PipelineListing,
  type SkillDiagnostic,
  type SkillListing,
} from "../../api";
import { catalogPath, navigate, pipelinePath } from "../../routes";
import { showToast } from "../../toast";
import { useHotkeys } from "../keys";
import {
  SKILL_FILTERS,
  findSkillPipeline,
  flattenGroups,
  groupSkills,
  invocationHint,
  scopeHint,
  skillFilterCounts,
  skillInvocationLabel,
  skillScopeLabel,
  skillSourceLabel,
  skillUsage,
  skillsFolderLabel,
  stepSelection,
  usedByRows,
  visibleSkills,
  type SkillFilter,
  type SkillInvocationLabel,
  type SkillScopeLabel,
  type SkillUsages,
} from "./catalogSkillModel";

const MONO = "font-['Geist_Mono',monospace]";
const EYEBROW =
  "text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]";
const ROW_CHIP = `inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[5px] border px-1.5 ${MONO} text-[11px] leading-normal`;
const FIELD_CHIP = `inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-[5px] border border-[#ffffff1a] bg-[#1a1c21] px-[7px] ${MONO} text-[11px] leading-normal text-[#ecedee]`;
const STAGE_CHIP = `${ROW_CHIP} border-[#ffffff24] bg-[#1a1c21] text-[#ecedee]`;
const FOOTER_KEYCAP = `rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] ${MONO} text-[11px] leading-normal text-[#8b8f98]`;

const CLI_FROM_PATH = "sf skills install --from-path ./my-skill";
const CLI_FROM_ZIP = "sf skills install --from-zip <url> --checksum sha256:…";
const CLI_LIST = "sf skills list";

function scopeChipClass(scope: SkillScopeLabel): string {
  if (scope === "temporary")
    return `${ROW_CHIP} border-dashed border-[#ffffff2e] text-[#a7aab2]`;
  if (scope === "built-in")
    return `${ROW_CHIP} border-[#ffffff12] bg-[#16171b] text-[#8b8f98]`;
  return `${ROW_CHIP} border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2]`;
}

function invocationChipClass(invocation: SkillInvocationLabel): string {
  if (invocation === "command-only")
    return `${ROW_CHIP} border-dashed border-[#ffffff2e] text-[#a7aab2]`;
  return `${ROW_CHIP} border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2]`;
}

async function copyText(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    showToast("Copy failed");
  }
}

function focusCatalogSearch(): void {
  const input =
    document.querySelector<HTMLInputElement>(
      "input[placeholder='Filter skills…']",
    ) ??
    document.querySelector<HTMLInputElement>(
      "[data-catalog-search] input, input[data-catalog-search]",
    );
  input?.focus();
}

function Icon({
  className = "size-3.5",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`block shrink-0 ${className}`}
      aria-hidden
    >
      {children}
    </svg>
  );
}

function ExternalIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </Icon>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void copyText(text, "Copied")}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#1a1c21] hover:text-[#ecedee]"
    >
      <CopyIcon className="size-3.5" />
    </button>
  );
}

function SkillsInfoStrip({ diagnostics }: { diagnostics: SkillDiagnostic[] }) {
  const first = diagnostics[0];
  return (
    <div className="flex min-h-9 w-full shrink-0 flex-col gap-1 border-b border-b-[#ffffff12] bg-[#131418] px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[#8b8f98]">
          <Icon>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </Icon>
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1 gap-y-0.5 text-xs leading-[1.4]">
          <span className="whitespace-nowrap text-[#a7aab2]">
            Skills come from Pi. A stage uses a skill only when its YAML sets
          </span>
          <span className={`whitespace-nowrap ${MONO} text-[#ecedee]`}>
            skill: &lt;name&gt;.
          </span>
          <span className="whitespace-nowrap text-[#a7aab2]">Lookup order:</span>
          <span className={`whitespace-nowrap ${MONO} text-[#ecedee]`}>
            run → checkout .pi/skills → host ~/.pi/agent/skills
          </span>
        </div>
        <button
          type="button"
          onClick={() =>
            showToast(
              "Set skill: on the pipeline stage entry. See docs/yaml-catalog.md.",
            )
          }
          className="flex shrink-0 items-center gap-1 text-xs font-medium text-[#a7aab2] hover:text-[#ecedee]"
        >
          Learn how
          <ExternalIcon className="size-3" />
        </button>
      </div>
      {first ? (
        <div
          className="truncate pl-[22px] text-xs text-[#f2645a]"
          title={first.path ?? first.message}
        >
          {first.message}
          {diagnostics.length > 1 ? ` +${diagnostics.length - 1} more` : ""}
        </div>
      ) : null}
    </div>
  );
}

function SkillFilterChips({
  filter,
  counts,
  onChange,
}: {
  filter: SkillFilter;
  counts: Record<SkillFilter, number>;
  onChange: (f: SkillFilter) => void;
}) {
  return (
    <div className="flex h-11 w-full shrink-0 items-center gap-1.5 border-b border-b-[#ffffff12] px-4">
      {SKILL_FILTERS.map((f) => {
        const active = filter === f.id;
        return (
          <div key={f.id} className="flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onChange(f.id)}
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs${
                active
                  ? " border-[#ffffff1a] bg-[#1a1c21] font-medium text-[#ecedee]"
                  : " border-[#ffffff12] text-[#a7aab2] hover:bg-[#1a1c21]"
              }`}
            >
              <span>{f.label}</span>
              <span
                className={`${MONO} text-[11px] ${active ? "text-[#a7aab2]" : "text-[#8b8f98]"}`}
              >
                {counts[f.id]}
              </span>
            </button>
            {f.id === "used" ? (
              <span className="mx-1 h-4 w-px shrink-0 bg-[#ffffff12]" />
            ) : null}
          </div>
        );
      })}
      <div className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-1.5 text-xs text-[#8b8f98]">
        <Icon className="size-3">
          <path d="m3 16 4 4 4-4" />
          <path d="M7 20V4" />
          <path d="m21 8-4-4-4 4" />
          <path d="M17 4v16" />
        </Icon>
        Grouped by usage
      </div>
    </div>
  );
}

function SkillTableHeader() {
  return (
    <div className="flex h-8 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4">
      <div className={`min-w-0 flex-1 ${EYEBROW}`}>Skill</div>
      <div className={`w-[88px] shrink-0 ${EYEBROW}`}>Scope</div>
      <div className={`w-[108px] shrink-0 ${EYEBROW}`}>Invocation</div>
      <div className="flex w-[104px] shrink-0 items-center gap-1">
        <span className={`${EYEBROW} text-[#ecedee]`}>Used by</span>
        <svg viewBox="0 0 24 24" className="size-3 text-[#ecedee]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
      </div>
      <div className={`w-[172px] shrink-0 ${EYEBROW}`}>Source</div>
    </div>
  );
}

function SkillRow({
  skill,
  usages,
  selected,
  onSelect,
}: {
  skill: SkillListing;
  usages: SkillUsages;
  selected: boolean;
  onSelect: () => void;
}) {
  const scope = skillScopeLabel(skill);
  const invocation = skillInvocationLabel(skill);
  const usage = skillUsage(usages, skill.name);
  const firstStage = usage.stage_ids[0];
  return (
    <button
      type="button"
      data-skill-row={skill.name}
      onClick={onSelect}
      className={`flex h-12 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] border-l-2 py-0 pl-3.5 pr-4 text-left${
        selected
          ? " border-l-[#ecedee] bg-[#131418]"
          : " border-l-transparent hover:bg-[#131418]"
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
        <span
          className={`truncate ${MONO} text-[13px] text-[#ecedee]${selected ? " font-medium" : ""}`}
        >
          {skill.name}
        </span>
        <span
          className="truncate text-xs text-[#8b8f98]"
          title={skill.description}
        >
          {skill.description}
        </span>
      </div>
      <div className="flex w-[88px] shrink-0 items-center">
        <span className={scopeChipClass(scope)}>{scope}</span>
      </div>
      <div className="flex w-[108px] shrink-0 items-center">
        <span className={invocationChipClass(invocation)}>{invocation}</span>
      </div>
      <div className="flex w-[104px] shrink-0 items-center gap-1 overflow-hidden">
        {usage.pipeline_ids.length > 0 ? (
          <>
            <span className={`${STAGE_CHIP} min-w-0 truncate`}>
              {firstStage ?? "stage"}
            </span>
            <span className={`shrink-0 ${MONO} text-[11px] text-[#8b8f98]`}>
              ×{usage.pipeline_ids.length}
            </span>
          </>
        ) : (
          <span className={`${MONO} text-xs text-[#8b8f98]`}>—</span>
        )}
      </div>
      <div
        className={`w-[172px] shrink-0 truncate ${MONO} text-xs text-[#8b8f98]`}
        title={skill.filePath}
      >
        {skillSourceLabel(skill)}
      </div>
    </button>
  );
}

function GroupHeading({
  label,
  count,
  hint,
  used,
}: {
  label: string;
  count: number;
  hint: string;
  used: boolean;
}) {
  return (
    <div className="flex h-8 w-full shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-4">
      <span className="text-[#8b8f98]">
        {used ? (
          <Icon className="size-[13px]">
            <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
            <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
            <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
          </Icon>
        ) : (
          <Icon className="size-[13px]">
            <circle cx="12" cy="12" r="10" />
          </Icon>
        )}
      </span>
      <span className="whitespace-nowrap text-[13px] font-semibold text-[#ecedee]">
        {label}
      </span>
      <span className={`${MONO} text-xs text-[#8b8f98]`}>{count}</span>
      <span className="flex-1" />
      <span className="truncate text-xs text-[#8b8f98]">{hint}</span>
    </div>
  );
}

function InstallStrip() {
  return (
    <div data-install-strip className="flex w-full shrink-0 flex-col gap-2 border-t border-t-[#ffffff12] px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`whitespace-nowrap ${EYEBROW}`}>Install a skill</span>
        <span className="rounded-sm border border-dashed border-[#ffffff2e] px-1 text-[10px] leading-normal text-[#8b8f98]">
          proposed
        </span>
        <span className="flex-1" />
        <span className="truncate text-xs text-[#8b8f98]">
          Runs the same install as the CLI, into
        </span>
        <span className={`whitespace-nowrap ${MONO} text-xs text-[#a7aab2]`}>
          .pi/skills/
        </span>
      </div>
      <div className="flex w-full gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-[#ffffff12] bg-[#131418] px-2.5 py-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2]">
            <Icon>
              <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
            </Icon>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium text-[#ecedee]">
              From folder
            </span>
            <span
              className={`truncate ${MONO} text-[11px] text-[#8b8f98]`}
              title={CLI_FROM_PATH}
            >
              {CLI_FROM_PATH}
            </span>
          </div>
          <CopyButton text={CLI_FROM_PATH} label="Copy install from folder command" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-[#ffffff12] bg-[#131418] px-2.5 py-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[#ffffff1a] bg-[#1a1c21] text-[#a7aab2]">
            <Icon>
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </Icon>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="whitespace-nowrap text-[13px] font-medium text-[#ecedee]">
                From zip URL
              </span>
              <span className="flex items-center gap-[3px] text-[11px] text-[#8b8f98]">
                <Icon className="size-[11px]">
                  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                  <path d="m9 12 2 2 4-4" />
                </Icon>
                with checksum
              </span>
            </div>
            <span
              className={`truncate ${MONO} text-[11px] text-[#8b8f98]`}
              title={CLI_FROM_ZIP}
            >
              {CLI_FROM_ZIP}
            </span>
          </div>
          <CopyButton text={CLI_FROM_ZIP} label="Copy install from zip command" />
        </div>
      </div>
    </div>
  );
}

function SkillsFooter({
  folder,
  total,
  used,
}: {
  folder: string;
  total: number;
  used: number;
}) {
  return (
    <div className="flex h-10 w-full shrink-0 items-center gap-3 border-t border-t-[#ffffff12] bg-[#08090a] px-4">
      <span className="text-[#8b8f98]">
        <Icon>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </Icon>
      </span>
      <span
        className={`min-w-0 truncate ${MONO} text-xs text-[#a7aab2]`}
        title={folder}
      >
        {folder}
      </span>
      <span className="whitespace-nowrap text-xs text-[#8b8f98]">
        {total} skills · {used} used by stages
      </span>
      <span className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-2.5 text-xs text-[#8b8f98]">
        <span className="flex items-center gap-1">
          <kbd className={FOOTER_KEYCAP}>J</kbd>
          <kbd className={FOOTER_KEYCAP}>K</kbd>
          move
        </span>
        <span className="flex items-center gap-1">
          <kbd className={FOOTER_KEYCAP}>Enter</kbd>
          open
        </span>
        <span className="flex items-center gap-1">
          <kbd className={FOOTER_KEYCAP}>/</kbd>
          search
        </span>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <span className={`w-24 shrink-0 ${EYEBROW}`}>{label}</span>
      {children}
    </div>
  );
}

function SkillInspector({
  skill,
  usages,
  usageFailed,
  pipelines,
}: {
  skill: SkillListing;
  usages: SkillUsages;
  usageFailed: boolean;
  pipelines: PipelineListing[];
}) {
  const scope = skillScopeLabel(skill);
  const invocation = skillInvocationLabel(skill);
  const usage = skillUsage(usages, skill.name);
  const rows = usedByRows(usage).map((row) => ({
    ...row,
    pipeline: row.pipelineId
      ? findSkillPipeline(pipelines, row.pipelineId, skill.name)
      : null,
  }));
  const firstLink = rows.find((r) => r.pipeline)?.pipeline ?? null;

  function openPipeline(p: PipelineListing) {
    navigate(pipelinePath(p.id, { project_root: p.project_root }));
  }

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-l-[#ffffff12] bg-[#131418]">
      <div className="flex w-full shrink-0 flex-col gap-2 border-b border-b-[#ffffff12] px-3.5 py-3">
        <span className={EYEBROW}>Skill</span>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`truncate ${MONO} text-[15px] font-semibold text-[#ecedee]`}
          >
            {skill.name}
          </span>
          <span className="flex h-[18px] shrink-0 items-center gap-1 rounded-sm border border-[#ffffff1a] px-[5px] text-[11px] text-[#8b8f98]">
            <Icon className="size-2.5">
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </Icon>
            read-only · Pi
          </span>
        </div>
        {skill.description ? (
          <p className="text-[13px] leading-[1.45] text-[#a7aab2]">
            {skill.description}
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 w-full flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <div className="flex flex-col gap-2">
          <FieldRow label="scope">
            <span className={FIELD_CHIP}>{scope}</span>
            <span className="min-w-0 truncate text-xs text-[#8b8f98]">
              {scopeHint(scope)}
            </span>
          </FieldRow>
          <FieldRow label="invocation">
            <span className={FIELD_CHIP}>{invocation}</span>
            <span className="min-w-0 truncate text-xs text-[#8b8f98]">
              {invocationHint(invocation)}
            </span>
          </FieldRow>
          <FieldRow label="filePath">
            <span
              className={`min-w-0 flex-1 truncate ${MONO} text-xs text-[#ecedee]`}
              title={skill.filePath}
            >
              {skill.filePath}
            </span>
          </FieldRow>
          <FieldRow label="baseDir">
            <span
              className={`min-w-0 flex-1 truncate ${MONO} text-xs text-[#a7aab2]`}
              title={skill.baseDir}
            >
              {skill.baseDir}
            </span>
          </FieldRow>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className={EYEBROW}>Used by</span>
            {!usageFailed ? (
              <span className={`${MONO} text-[11px] text-[#a7aab2]`}>
                {usage.pipeline_ids.length}
              </span>
            ) : null}
            <span className="flex-1" />
            {firstLink ? (
              <button
                type="button"
                onClick={() => openPipeline(firstLink)}
                className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-[#a7aab2] hover:bg-[#1a1c21] hover:text-[#ecedee]"
              >
                Open stage
                <ExternalIcon className="size-3" />
              </button>
            ) : null}
          </div>
          {usageFailed ? (
            <p className="text-xs text-[#8b8f98]">Usage index unavailable</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-[#8b8f98]">
              No stage sets skill: {skill.name} yet.
            </p>
          ) : (
            <div className="flex flex-col rounded-[10px] border border-[#ffffff12]">
              {rows.map((row, i) => {
                const last = i === rows.length - 1;
                const body = (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className={STAGE_CHIP}>{row.stageId}</span>
                      {row.pipelineId ? (
                        <>
                          <span className="text-[#8b8f98]">
                            <Icon className="size-3">
                              <path d="M5 12h14" />
                              <path d="m12 5 7 7-7 7" />
                            </Icon>
                          </span>
                          <span
                            className={`min-w-0 flex-1 truncate ${MONO} text-xs text-[#ecedee]`}
                          >
                            {row.pipelineId}
                          </span>
                        </>
                      ) : (
                        <span className="flex-1" />
                      )}
                      {row.pipeline ? (
                        <span className="text-[#8b8f98]">
                          <Icon>
                            <path d="m9 18 6-6-6-6" />
                          </Icon>
                        </span>
                      ) : null}
                    </div>
                    <span
                      className={`truncate ${MONO} text-[11px] text-[#8b8f98]`}
                    >
                      skill: {skill.name}
                    </span>
                  </>
                );
                const cls = `flex flex-col gap-[3px] px-2.5 py-[7px] text-left${
                  last ? "" : " border-b border-b-[#ffffff12]"
                }`;
                const pipeline = row.pipeline;
                return pipeline ? (
                  <button
                    key={`${row.pipelineId}:${i}`}
                    type="button"
                    onClick={() => openPipeline(pipeline)}
                    className={`${cls} hover:bg-[#1a1c21]`}
                  >
                    {body}
                  </button>
                ) : (
                  <div key={`${row.pipelineId ?? row.stageId}:${i}`} className={cls}>
                    {body}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[#8b8f98]">
              <Icon className="size-3">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                <path d="M10 9H8" />
                <path d="M16 13H8" />
                <path d="M16 17H8" />
              </Icon>
            </span>
            <span className={`flex-1 ${MONO} text-[11px] text-[#8b8f98]`}>
              SKILL.md
            </span>
            <button
              type="button"
              onClick={() => void copyText(skill.filePath, "Copied path")}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-[#a7aab2] hover:bg-[#1a1c21] hover:text-[#ecedee]"
            >
              Open file
              <ExternalIcon className="size-3" />
            </button>
          </div>
          <div className="flex flex-col gap-[5px] rounded-[10px] border border-[#ffffff12] bg-[#0c0d0f] px-3 py-2.5">
            <span className={`truncate ${MONO} text-[11px] text-[#8b8f98]`}>
              name: {skill.name}
            </span>
            <span className="my-0.5 block h-px w-full bg-[#ffffff12]" />
            <p className="text-xs leading-[1.45] text-[#a7aab2]">
              {skill.description || "No description."}
            </p>
            <p className="break-all text-[11px] leading-[1.45] text-[#8b8f98]">
              Full SKILL.md is on disk at{" "}
              <span className={MONO}>{skill.filePath}</span>.
            </p>
          </div>
        </div>
      </div>

      <div className="flex w-full shrink-0 flex-col gap-2 border-t border-t-[#ffffff12] px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void copyText(skill.name, "Copied")}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 text-[13px] font-medium text-[#ecedee] hover:bg-[#202228]"
          >
            <span className="text-[#a7aab2]">
              <CopyIcon />
            </span>
            Copy name
            <kbd
              className={`rounded-sm border border-[#ffffff1a] px-[5px] ${MONO} text-[11px] leading-normal text-[#8b8f98]`}
            >
              C
            </kbd>
          </button>
          <button
            type="button"
            onClick={() => void copyText(skill.filePath, "Copied path")}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-[#a7aab2] hover:bg-[#1a1c21] hover:text-[#ecedee]"
          >
            <Icon>
              <path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1" />
              <path d="m21 21-1.9-1.9" />
              <circle cx="17" cy="17" r="3" />
            </Icon>
            Reveal in Finder
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[#8b8f98]">
            <Icon className="size-3">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" x2="20" y1="19" y2="19" />
            </Icon>
          </span>
          <span className={`whitespace-nowrap ${MONO} text-xs text-[#a7aab2]`}>
            $ {CLI_LIST}
          </span>
          <CopyButton text={CLI_LIST} label="Copy sf skills list" />
          <span className="min-w-0 truncate text-xs text-[#8b8f98]">
            shows every skill and its source
          </span>
        </div>
      </div>
    </aside>
  );
}

export function CatalogSkillsTab({
  skillName,
  query = "",
}: {
  skillName?: string;
  query?: string;
}) {
  const [skills, setSkills] = useState<SkillListing[]>([]);
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  const [usages, setUsages] = useState<SkillUsages>({});
  const [usageFailed, setUsageFailed] = useState(false);
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [selectedName, setSelectedName] = useState<string | null>(
    skillName ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [skillsResult, usageResult, pipelinesResult] =
      await Promise.allSettled([
        fetchSkills(),
        fetchSkillUsage(),
        fetchPipelines(),
      ]);
    if (skillsResult.status === "fulfilled") {
      setSkills(skillsResult.value.skills);
      setDiagnostics(skillsResult.value.diagnostics);
      setError(null);
    } else {
      const err = skillsResult.reason;
      setError(err instanceof Error ? err.message : String(err));
    }
    if (usageResult.status === "fulfilled") {
      setUsages(usageResult.value.usages);
      setUsageFailed(false);
    } else {
      setUsages({});
      setUsageFailed(true);
    }
    if (pipelinesResult.status === "fulfilled") {
      setPipelines(pipelinesResult.value.pipelines);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (skillName) setSelectedName(skillName);
  }, [skillName]);

  const queried = useMemo(
    () => visibleSkills(skills, "all", query, usages),
    [skills, query, usages],
  );
  const counts = useMemo(
    () => skillFilterCounts(queried, usages),
    [queried, usages],
  );
  const visible = useMemo(
    () => visibleSkills(skills, filter, query, usages),
    [skills, filter, query, usages],
  );
  const groups = useMemo(() => groupSkills(visible, usages), [visible, usages]);
  const ordered = useMemo(() => flattenGroups(groups), [groups]);
  const orderedNames = useMemo(() => ordered.map((s) => s.name), [ordered]);

  useEffect(() => {
    if (orderedNames.length === 0) return;
    if (!selectedName || !orderedNames.includes(selectedName)) {
      setSelectedName(orderedNames[0]!);
    }
  }, [orderedNames, selectedName]);

  const selected = useMemo(
    () => ordered.find((s) => s.name === selectedName) ?? null,
    [ordered, selectedName],
  );

  useEffect(() => {
    if (!selectedName || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-skill-row="${CSS.escape(selectedName)}"]`,
    );
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selectedName]);

  const selectSkill = useCallback((name: string) => {
    setSelectedName(name);
    navigate(catalogPath({ tab: "skills", skill: name }));
  }, []);

  function move(delta: number) {
    const next = stepSelection(orderedNames, selectedName, delta);
    if (next && next !== selectedName) selectSkill(next);
  }

  useHotkeys(
    [
      {
        key: "j",
        scope: "catalog",
        handler: (e) => {
          e.preventDefault();
          move(1);
        },
      },
      {
        key: "k",
        scope: "catalog",
        handler: (e) => {
          e.preventDefault();
          move(-1);
        },
      },
      {
        key: "enter",
        scope: "catalog",
        when: () => orderedNames.length > 0,
        handler: (e) => {
          e.preventDefault();
          const target = selected?.name ?? orderedNames[0];
          if (target && target !== skillName) selectSkill(target);
        },
      },
      {
        key: "c",
        scope: "catalog",
        when: () => selected !== null,
        handler: (e) => {
          e.preventDefault();
          if (selected) void copyText(selected.name, "Copied");
        },
      },
      {
        key: "/",
        scope: "catalog",
        handler: (e) => {
          e.preventDefault();
          focusCatalogSearch();
        },
      },
    ],
    "catalog",
  );

  const usedCount = visible.filter(
    (s) => skillUsage(usages, s.name).stage_ids.length > 0,
  ).length;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <SkillsInfoStrip diagnostics={diagnostics} />
        <SkillFilterChips filter={filter} counts={counts} onChange={setFilter} />
        <SkillTableHeader />
        <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {error ? (
            <p className="px-4 py-3 text-xs text-[#f2645a]">{error}</p>
          ) : null}
          {loading ? (
            <p className="px-4 py-3 text-xs text-[#8b8f98]">Loading skills…</p>
          ) : null}
          {!loading && !error && ordered.length === 0 ? (
            <p className="px-4 py-3 text-xs text-[#8b8f98]">No skills found.</p>
          ) : null}
          {groups.map((group) => (
            <div key={group.id} className="flex flex-col">
              <GroupHeading
                label={group.label}
                count={group.skills.length}
                hint={group.hint}
                used={group.id === "used"}
              />
              {group.skills.map((skill) => (
                <SkillRow
                  key={`${skill.scope}:${skill.filePath}`}
                  skill={skill}
                  usages={usages}
                  selected={selectedName === skill.name}
                  onSelect={() => selectSkill(skill.name)}
                />
              ))}
            </div>
          ))}
        </div>
        <InstallStrip />
        <SkillsFooter
          folder={visible.length > 0 ? skillsFolderLabel(visible) : ".pi/skills"}
          total={visible.length}
          used={usedCount}
        />
      </div>
      {selected ? (
        <SkillInspector
          skill={selected}
          usages={usages}
          usageFailed={usageFailed}
          pipelines={pipelines}
        />
      ) : null}
    </div>
  );
}
