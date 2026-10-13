import { LuX } from "react-icons/lu";
import type { WorkshopGraphChip, WorkshopGraphNode } from "./workshopGraphModel";

export type WorkshopGraphNodeCardProps = {
  node: WorkshopGraphNode;
  selected: boolean;
  onSelect: (id: string) => void;
};

const MONO = "font-['Geist_Mono',monospace]";

function cardClass(node: WorkshopGraphNode, selected: boolean): string {
  const base =
    "flex w-[208px] shrink-0 cursor-pointer flex-col gap-[3px] self-start rounded-[10px] border px-2.5 py-[7px] text-left outline-none transition-[background-color,border-color,box-shadow] focus-visible:shadow-[0px_0px_0px_3px_rgba(108,166,255,0.14)]";
  const dashed = node.status === "edited" ? "border-dashed" : "";
  if (selected) {
    return `${base} ${dashed} bg-[#1a1c21] border-[#6ca6ffd9] shadow-[0px_0px_0px_3px_rgba(108,166,255,0.14)]`;
  }
  if (node.status === "edited") {
    return `${base} ${dashed} bg-[#131418] border-[#6ca6ff99] hover:bg-[#16181c]`;
  }
  if (node.status === "new") {
    return `${base} bg-[#131418] border-[#6ca6ff99] hover:bg-[#16181c]`;
  }
  return `${base} bg-[#131418] border-[#ffffff1a] hover:border-[#ffffff26] hover:bg-[#16181c]`;
}

function chipClass(chip: WorkshopGraphChip, selected: boolean): string {
  const base = "h-[18px] content-center whitespace-nowrap rounded-sm border px-1.5 text-[11px] leading-normal";
  switch (chip.variant) {
    case "changed":
      return `${base} ${MONO} bg-[#6ca6ff1a] border-[#6ca6ff73] text-[#6ca6ff]`;
    case "dashed":
      return `${base} font-sans border-dashed border-[#ffffff1f] text-[#8b8f98]`;
    case "dashed-changed":
      return `${base} font-sans border-dashed border-[#6ca6ff73] text-[#6ca6ff]`;
    default:
      return `${base} ${MONO} ${selected ? "bg-[#131418]" : "bg-[#1a1c21]"} border-[#ffffff1a] text-[#a7aab2]`;
  }
}

function StatusTag({ status }: { status: WorkshopGraphNode["status"] }) {
  if (status === "unchanged") return null;
  const look =
    status === "new"
      ? "bg-[#6ca6ff24] border-[#6ca6ff99]"
      : "border-dashed border-[#6ca6ff99]";
  return (
    <span
      className={`h-4 shrink-0 content-center rounded-sm border px-[5px] font-sans text-[10px] font-medium leading-normal text-[#6ca6ff] ${look}`}
    >
      {status}
    </span>
  );
}

export function WorkshopGraphNodeCard({ node, selected, onSelect }: WorkshopGraphNodeCardProps) {
  return (
    <button
      type="button"
      data-graph-node={node.id}
      aria-pressed={selected}
      className={cardClass(node, selected)}
      onClick={() => onSelect(node.id)}
    >
      <span className="flex w-full items-center gap-1.5">
        <span
          className={`${MONO} min-w-0 flex-1 truncate text-[13px] font-medium leading-normal text-[#ecedee]`}
          title={node.id}
        >
          {node.id}
        </span>
        <StatusTag status={node.status} />
      </span>
      <span
        className={`${MONO} block w-full truncate text-[11px] leading-normal text-[#8b8f98]`}
        title={node.model}
      >
        {node.model}
      </span>
      {node.chips.length > 0 ? (
        <span className="flex flex-wrap gap-1 pt-0.5">
          {node.chips.map((chip) => (
            <span key={chip.kind} className={chipClass(chip, selected)}>
              {chip.label}
            </span>
          ))}
        </span>
      ) : null}
      {node.errorSummary ? (
        <span className="mt-0.5 flex w-full items-center gap-[5px] border-t border-t-[#f2645a40] pt-[5px]">
          <LuX aria-hidden className="size-3 shrink-0 text-[#f2645a]" />
          <span className={`${MONO} truncate text-[11px] leading-normal text-[#f2645a]`}>
            {node.errorSummary}
          </span>
        </span>
      ) : null}
    </button>
  );
}
