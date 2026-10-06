import { catalogPath } from "../../routes";
import { navigate } from "../../routes";
import type { CatalogTabId } from "./CatalogTabs";

export type CatalogHeaderBarProps = {
  active: CatalogTabId;
  stageCount?: number;
  skillCount?: number;
  extensionCount?: number;
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
      className={`flex h-full items-center gap-1.5 rounded-md px-2.5 py-0 text-[13px]${
        active
          ? " border border-[#ffffff1a] bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"
          : " text-[var(--sf-text-2)]"
      }`}
    >
      <span>{label}</span>
      {count != null ? (
        <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
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
}: CatalogHeaderBarProps) {
  function go(tab: CatalogTabId) {
    navigate(catalogPath({ tab }));
  }

  return (
    <div className="flex h-14 w-full shrink-0 items-center gap-3 border-b border-b-[#ffffff12] px-4 py-0">
      <h1 className="shrink-0 text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">
        Catalog
      </h1>
      <div
        className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-[#ffffff12] bg-[var(--sf-panel)] p-0.5"
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
    </div>
  );
}
