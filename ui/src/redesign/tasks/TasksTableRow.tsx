import type { IconType } from "react-icons";
import {
  LuBan,
  LuCheck,
  LuClock,
  LuHand,
  LuLoaderCircle,
  LuX,
} from "react-icons/lu";
import {
  formatUsd,
  relativeAgo,
  type TaskLastRunKind,
  type TaskRowView,
} from "./taskViews";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const NOWRAP = "[white-space-collapse:collapse] [text-wrap-mode:nowrap]";
const COL_LABEL = `text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase ${NOWRAP}`;

type PillStyle = { label: string; icon: IconType; pill: string; tone: string };

const PILL_STYLES: Record<TaskLastRunKind, PillStyle> = {
  waiting: {
    label: "Needs you",
    icon: LuHand,
    pill: "bg-[#f5b5441f] border border-[#f5b5444d] shadow-[0px_0px_10px_rgba(245,181,68,0.25)]",
    tone: "text-[#f5b544]",
  },
  running: {
    label: "Running",
    icon: LuLoaderCircle,
    pill: "bg-[#6ca6ff1a]",
    tone: "text-[#6ca6ff]",
  },
  failed: {
    label: "Failed",
    icon: LuX,
    pill: "bg-[#f2645a1a]",
    tone: "text-[#f2645a]",
  },
  succeeded: {
    label: "Succeeded",
    icon: LuCheck,
    pill: "bg-[#4cc38a1a]",
    tone: "text-[#4cc38a]",
  },
  cancelled: {
    label: "Abandoned",
    icon: LuBan,
    pill: "bg-[#8b8f981a]",
    tone: "text-[#8b8f98] line-through",
  },
  none: {
    label: "Never run",
    icon: LuClock,
    pill: "border border-dashed border-[#a7aab266]",
    tone: "text-[#a7aab2]",
  },
};

export function TaskRunPill({
  kind,
  suffix,
}: {
  kind: TaskLastRunKind;
  suffix?: string;
}) {
  const style = PILL_STYLES[kind];
  const Icon = style.icon;
  const label = suffix ? `${style.label} · ${suffix}` : style.label;
  return (
    <span
      className={`flex h-6 shrink-0 items-center rounded-full px-2 py-0 gap-[5px] ${style.pill}`}
      aria-label={label}
    >
      <Icon className={`size-3 block shrink-0 ${style.tone}`} aria-hidden="true" />
      <span className={`w-fit font-sans text-xs font-medium leading-normal ${NOWRAP} ${style.tone}`}>
        {label}
      </span>
    </span>
  );
}

export function TasksColumnHeader() {
  return (
    <div className="flex w-full h-8 shrink-0 items-center border-b px-5 py-0 gap-3 border-b-[#ffffff12]">
      <div className={`min-w-0 flex-1 text-left ${COL_LABEL}`}>Task</div>
      <div className={`w-[108px] shrink-0 text-left ${COL_LABEL}`}>Last run</div>
      <div className={`w-[92px] shrink-0 text-left ${COL_LABEL}`}>Pipeline</div>
      <div className={`w-9 shrink-0 text-right ${COL_LABEL}`}>Runs</div>
      <div className={`w-[60px] shrink-0 text-right ${COL_LABEL}`}>When</div>
      <div className={`w-[52px] shrink-0 text-right ${COL_LABEL}`}>Cost</div>
    </div>
  );
}

export function TasksTableRow({
  row,
  selected,
  rootLabel,
  onSelect,
}: {
  row: TaskRowView;
  selected: boolean;
  rootLabel?: string;
  onSelect: () => void;
}) {
  const { task, runs, last, kind, pipeline, costUsd } = row;
  const dim = kind === "cancelled";
  const never = kind === "none";
  const idTone = dim ? "text-[#a7aab2]" : "text-[#ecedee]";
  const metaTone = dim ? "text-[#8b8f98]" : "text-[#a7aab2]";
  const countTone = never ? "text-[#8b8f98]" : metaTone;
  const costTone =
    costUsd === undefined ? "text-[#8b8f98]" : dim ? "text-[#a7aab2]" : "text-[#ecedee]";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-task-row=""
      className={`flex relative w-full h-12 shrink-0 items-center border-b px-5 py-0 gap-3 border-b-[#ffffff12] text-left ${
        selected ? "bg-[#131418]" : "bg-transparent hover:bg-[#131418]"
      }`}
    >
      {selected ? (
        <span className="block absolute w-0.5 h-12 left-0 top-0 bg-[#ecedee]" aria-hidden="true" />
      ) : null}
      <span className="flex min-w-0 flex-col flex-1 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5" title={task.id}>
          <span className={`min-w-0 truncate ${MONO} text-[13px] leading-normal ${idTone}`}>
            {task.id}
          </span>
          {rootLabel ? (
            <span className={`shrink-0 truncate ${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
              {rootLabel}
            </span>
          ) : null}
        </span>
        <span
          className={`min-w-0 truncate font-sans text-xs leading-normal ${dim ? "text-[#8b8f98]" : "text-[#a7aab2]"}`}
          title={task.goal}
        >
          {task.goal}
        </span>
      </span>
      <span className="flex w-[108px] shrink-0">
        <TaskRunPill kind={kind} />
      </span>
      <span
        className={`w-[92px] min-w-0 shrink-0 truncate ${MONO} text-xs leading-normal ${metaTone}`}
        title={pipeline?.id}
      >
        {pipeline?.id ?? "—"}
      </span>
      <span className={`w-9 shrink-0 text-right ${MONO} text-xs leading-normal ${countTone}`}>
        {runs.length}
      </span>
      <span
        className={`w-[60px] shrink-0 text-right ${MONO} text-xs leading-normal ${NOWRAP} ${countTone}`}
      >
        {last ? relativeAgo(last.created_at) : "—"}
      </span>
      <span className={`w-[52px] shrink-0 text-right ${MONO} text-xs leading-normal ${costTone}`}>
        {formatUsd(costUsd)}
      </span>
    </button>
  );
}
