import type { RefObject } from "react";
import { LuDownload, LuPlus, LuSearch } from "react-icons/lu";
import { catalogPath, navigate } from "../../routes";
import type { CatalogTabId } from "./CatalogTabs";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const PRIMARY_KEYCAP = `rounded-sm border border-[#0c0d0f2e] px-[5px] py-0 ${MONO} text-[11px] leading-normal text-[#5a5d66]`;

const PLACEHOLDERS: Record<CatalogTabId, string> = {
  stages: "Filter stages…",
  skills: "Filter skills…",
  extensions: "Filter extensions…",
};

export type CatalogHeaderBarProps = {
  active: CatalogTabId;
  stageCount?: number;
  skillCount?: number;
  extensionCount?: number;
  query: string;
  onQueryChange: (value: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  onNewStage?: () => void;
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
  extensionCount,
  query,
  onQueryChange,
  searchRef,
  onNewStage,
}: CatalogHeaderBarProps) {
  function go(tab: CatalogTabId) {
    navigate(catalogPath({ tab }));
  }

  return (
    <div className="flex h-14 w-full shrink-0 items-center gap-3 border-b border-b-[#ffffff12] px-4 py-0">
      <h1 className="w-fit shrink-0 font-sans text-xl font-semibold leading-normal tracking-[-0.4px] text-[#ecedee]">
        Catalog
      </h1>
      <div
        className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-[#ffffff12] bg-[#131418] p-0.5"
        role="tablist"
      >
        <SegmentedTab
          active={active === "stages"}
          label="Stages"
          count={stageCount}
          onClick={() => go("stages")}
        />
        <SegmentedTab
          active={active === "skills"}
          label="Skills"
          count={skillCount}
          onClick={() => go("skills")}
        />
        <SegmentedTab
          active={active === "extensions"}
          label="Extensions"
          count={extensionCount}
          onClick={() => go("extensions")}
        />
      </div>
      <span className="block min-w-0 flex-1" />
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
          placeholder={PLACEHOLDERS[active]}
          aria-label={PLACEHOLDERS[active]}
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
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-sm border border-dashed border-[#ffffff2e] px-1 py-0 font-sans text-[10px] leading-normal text-[#8b8f98]">
            proposed
          </span>
          <button
            type="button"
            title="Install skills with the CLI shown below the list"
            onClick={() =>
              document.querySelector("[data-install-strip]")?.scrollIntoView({ block: "nearest" })
            }
            className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[#ecedee] px-3 py-0"
          >
            <LuDownload className="size-3.5 text-[#0c0d0f]" aria-hidden />
            <span className="font-sans text-[13px] font-medium leading-normal text-[#0c0d0f]">
              Install skill
            </span>
            <span className={PRIMARY_KEYCAP}>I</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
