import type { RefObject } from "react";
import { LuDownload, LuPlus, LuSearch } from "react-icons/lu";
import { catalogPath, navigate } from "../../routes";
import { PageHeader } from "../shell/PageHeader";
import type { CatalogTabId } from "./CatalogTabs";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const PRIMARY_KEYCAP = `rounded-sm border border-[#0c0d0f2e] px-[5px] py-0 ${MONO} text-[11px] leading-normal text-[#5a5d66]`;

const PLACEHOLDERS: Record<"stages" | "skills", string> = {
  stages: "Filter stages…",
  skills: "Filter skills…",
};

export type CatalogHeaderBarProps = {
  active: CatalogTabId;
  stageCount?: number;
  skillCount?: number;
  query: string;
  onQueryChange: (value: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  onNewStage?: () => void;
  onInstallSkill?: () => void;
};

function SegmentedTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-full items-center gap-1.5 rounded-md px-2.5 py-0 text-[13px] leading-normal ${
        active
          ? "border border-[#ffffff1a] bg-[#1a1c21] font-medium text-[#ecedee]"
          : "border border-transparent text-[#a7aab2] hover:text-[#ecedee]"
      }`}
    >
      <span>{label}</span>
      {count != null ? (
        <span
          className={`${MONO} text-xs leading-normal ${active ? "text-[#a7aab2]" : "text-[#8b8f98]"}`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function CatalogHeaderBar({
  active,
  stageCount,
  skillCount,
  query,
  onQueryChange,
  searchRef,
  onNewStage,
  onInstallSkill,
}: CatalogHeaderBarProps) {
  const visibleTab: "stages" | "skills" =
    active === "skills" ? "skills" : "stages";

  function go(tab: "stages" | "skills") {
    navigate(catalogPath({ tab }));
  }

  return (
    <PageHeader
      title="Catalog"
      titleAddon={
        <div
          className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-[#ffffff12] bg-[#131418] p-0.5"
          role="tablist"
        >
          <SegmentedTab
            active={visibleTab === "stages"}
            label="Stages"
            count={stageCount}
            onClick={() => go("stages")}
          />
          <SegmentedTab
            active={visibleTab === "skills"}
            label="Skills"
            count={skillCount}
            onClick={() => go("skills")}
          />
        </div>
      }
      actions={
        <>
          {active === "stages" ? (
            <button
              type="button"
              onClick={onNewStage}
              className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[#ecedee] px-3 py-0"
            >
              <LuPlus className="size-3.5 text-[#0c0d0f]" aria-hidden />
              <span className="font-sans text-[13px] font-medium leading-normal text-[#0c0d0f]">
                New stage
              </span>
              <span className={PRIMARY_KEYCAP}>N</span>
            </button>
          ) : null}
          {active === "skills" ? (
            <button
              type="button"
              onClick={onInstallSkill}
              className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[#ecedee] px-3 py-0"
            >
              <LuDownload className="size-3.5 text-[#0c0d0f]" aria-hidden />
              <span className="font-sans text-[13px] font-medium leading-normal text-[#0c0d0f]">
                Install skill
              </span>
              <span className={PRIMARY_KEYCAP}>I</span>
            </button>
          ) : null}
        </>
      }
    >
      <label className="flex h-8 w-[200px] shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#131418] px-2.5 py-0 focus-within:border-[#ecedee73]">
        <LuSearch className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
        <input
          ref={searchRef}
          data-catalog-search
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onQueryChange("");
              e.currentTarget.blur();
            }
          }}
          placeholder={PLACEHOLDERS[visibleTab]}
          aria-label={PLACEHOLDERS[visibleTab]}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-sans text-[13px] leading-normal text-[#ecedee] outline-none placeholder:text-[#8b8f98]"
        />
        <span
          className={`rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] py-0 ${MONO} text-[11px] leading-normal text-[#8b8f98]`}
        >
          /
        </span>
      </label>
    </PageHeader>
  );
}
