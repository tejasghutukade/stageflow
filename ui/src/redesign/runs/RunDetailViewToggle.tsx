import type { IconType } from "react-icons";
import { LuAlignLeft, LuLayoutGrid, LuList } from "react-icons/lu";
import type { RunDetailViewMode } from "./RunDetailHeader";

const MODES: {
  id: RunDetailViewMode;
  label: string;
  Icon: IconType;
}[] = [
  { id: "timeline", label: "Timeline", Icon: LuAlignLeft },
  { id: "graph", label: "Graph", Icon: LuLayoutGrid },
  { id: "list", label: "List", Icon: LuList },
];

export function RunDetailViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: RunDetailViewMode;
  onViewModeChange: (mode: RunDetailViewMode) => void;
}) {
  return (
    <div className="flex h-8 items-center gap-0.5 rounded-lg border border-[#ffffff1a] bg-[var(--sf-panel)] p-[3px]">
      {MODES.map(({ id, label, Icon }) => {
        const selected = viewMode === id;
        return (
          <button
            key={id}
            type="button"
            className={
              selected
                ? "flex h-6 items-center gap-1.5 rounded-md border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 py-0"
                : "flex h-6 items-center gap-1.5 rounded-md px-2.5 py-0"
            }
            onClick={() => onViewModeChange(id)}
          >
            <Icon
              className={`size-[13px] shrink-0${selected ? " text-[var(--sf-text-1)]" : " text-[var(--sf-text-3)]"}`}
              aria-hidden="true"
            />
            <span
              className={`font-sans text-xs font-medium leading-normal${selected ? " text-[var(--sf-text-1)]" : " text-[var(--sf-text-2)]"}`}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
