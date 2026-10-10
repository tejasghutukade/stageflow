import { LuCircleX, LuTriangleAlert } from "react-icons/lu";
import { formatStageStats } from "./editorGraphLayout";
import type { EditorStageCardModel, StageStats } from "./editorGraphLayout";

export type EditorStageCardProps = {
  stageId: string;
  card: EditorStageCardModel;
  selected: boolean;
  finding?: "error" | "warning";
  stats?: StageStats;
  loops?: string[];
  onSelect: (stageId: string) => void;
};

export function EditorStageCard({
  stageId,
  card,
  selected,
  finding,
  stats,
  loops = [],
  onSelect,
}: EditorStageCardProps) {
  const chipBg = selected ? "bg-[#131418]" : "bg-[#1a1c21]";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(stageId)}
      className={`flex w-[218px] shrink-0 flex-col gap-[7px] rounded-[10px] border p-2.5 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#ecedee8c] ${
        selected
          ? "border-[#ecedee8c] bg-[#1a1c21] shadow-[0px_0px_0px_3px_rgba(236,237,238,0.07)]"
          : "border-[#ffffff1a] bg-[#131418] hover:border-[#ffffff29]"
      }`}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="min-w-0 truncate font-['Geist_Mono',monospace] text-[13px] font-medium text-[#ecedee]">
          {stageId}
        </span>
        {finding === "error" ? (
          <LuCircleX aria-label="Has errors" className="size-3 shrink-0 text-[#e5484d]" />
        ) : finding === "warning" ? (
          <LuTriangleAlert aria-label="Has warnings" className="size-3 shrink-0 text-[#a7aab2]" />
        ) : null}
        <span className="min-w-0 flex-1" />
        {card.model ? (
          <span
            className="max-w-[120px] truncate font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]"
            title={card.model}
          >
            {card.model}
          </span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {card.gateKinds.length > 0 ? (
          card.gateKinds.map((kind) => (
            <span
              key={kind}
              className={`h-[18px] content-center rounded-sm border px-1.5 font-['Geist_Mono',monospace] text-[11px] text-[#a7aab2] ${chipBg} ${
                kind === "artifact_backed" ? "border-dashed border-[#a7aab28c]" : "border-[#ffffff1a]"
              }`}
            >
              {kind}
            </span>
          ))
        ) : (
          <span className="h-[18px] content-center rounded-sm border border-dashed border-[#ffffff1f] px-1.5 text-[11px] text-[#8b8f98]">
            no gate · auto
          </span>
        )}
        {loops.map((target) => (
          <span
            key={`loop:${target}`}
            className="h-[18px] content-center rounded-sm border border-dashed border-[#ffffff1f] px-1.5 font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]"
            title={`Loops back to ${target}`}
          >
            ↺ {target}
          </span>
        ))}
        {card.needs.length >= 2 ? (
          <span className="h-[18px] content-center px-1 text-[11px] text-[#8b8f98]">
            needs {card.needs.join(" + ")}
          </span>
        ) : null}
      </span>
      <span
        className={`truncate whitespace-nowrap border-t border-t-[#ffffff12] pt-1.5 font-['Geist_Mono',monospace] text-[11px] ${
          selected ? "text-[#a7aab2]" : "text-[#8b8f98]"
        }`}
      >
        {formatStageStats(stats)}
      </span>
    </button>
  );
}
