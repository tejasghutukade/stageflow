import type { TriggerListItem } from "../../api";
import { LuClock, LuMousePointerClick, LuRadio } from "react-icons/lu";
import { triggerNextCell, triggerRowSummary } from "./triggerRowMeta";

function KindIcon({ kind }: { kind: TriggerListItem["kind"] }) {
  const className = "size-4 shrink-0 text-[var(--sf-text-2)]";
  if (kind === "schedule") return <LuClock className={className} aria-hidden />;
  if (kind === "event") return <LuRadio className={className} aria-hidden />;
  return <LuMousePointerClick className={className} aria-hidden />;
}

export function TriggerListRow({
  trigger,
  selected,
  onClick,
}: {
  trigger: TriggerListItem;
  selected: boolean;
  onClick: () => void;
}) {
  const next = triggerNextCell(trigger);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex relative w-full h-14 shrink-0 items-center border-b px-4 py-0 gap-2.5 border-b-[#ffffff12] text-left${
        selected ? " bg-[var(--sf-active)]" : " bg-transparent hover:bg-[var(--sf-raised)]"
      }`}
    >
      <div className="flex w-5 shrink-0 justify-center">
        <KindIcon kind={trigger.kind} />
      </div>
      <div className="flex min-w-0 flex-col flex-1 gap-0.5">
        <div
          className="min-w-0 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)]"
          title={trigger.id}
        >
          {trigger.id}
        </div>
        <div
          className="min-w-0 truncate text-xs text-[var(--sf-text-2)]"
          title={triggerRowSummary(trigger)}
        >
          {triggerRowSummary(trigger)}
        </div>
      </div>
      <div className="flex w-[120px] min-w-0 shrink-0 flex-col gap-0.5">
        <div
          className="min-w-0 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]"
          title={trigger.pipeline}
        >
          {trigger.pipeline}
        </div>
        {trigger.task ? (
          <div
            className="min-w-0 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]"
            title={trigger.task}
          >
            {trigger.task}
          </div>
        ) : (
          <span className="inline-flex h-[18px] w-fit items-center rounded-sm border border-[#ffffff1a] bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-2)]">
            dynamic task
          </span>
        )}
      </div>
      <div className="flex w-20 shrink-0 items-center gap-1.5">
        {next.dot === "ok" ? (
          <span className="size-1.5 shrink-0 rounded-full bg-[var(--sf-ok)]" />
        ) : null}
        <span className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
          {next.label}
        </span>
      </div>
      <div className="w-16 shrink-0 text-right">
        <span
          className={`text-[11px] ${trigger.enabled ? "text-[var(--sf-text-2)]" : "text-[var(--sf-text-3)]"}`}
        >
          {trigger.enabled ? "on" : "off"}
        </span>
      </div>
    </button>
  );
}
