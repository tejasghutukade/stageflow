import type { MouseEvent } from "react";
import type { RunSummary, TriggerListItem } from "../../api";
import { relativeTime, runShortId } from "../../catalogJoin";
import {
  LuCheck,
  LuClock,
  LuGithub,
  LuMail,
  LuMousePointer2,
  LuPlay,
  LuRadio,
  LuTriangleAlert,
  LuWebhook,
  LuX,
} from "react-icons/lu";
import {
  runOutcome,
  triggerFireState,
  triggerNextCell,
  triggerSourceIcon,
  triggerSummaryLine,
  type RunOutcome,
  type TriggerSourceIcon,
} from "./triggerListModel";

const MONO = "font-['Geist_Mono',monospace]";

export function TriggerSourceGlyph({
  icon,
  className,
}: {
  icon: TriggerSourceIcon;
  className: string;
}) {
  if (icon === "schedule") return <LuClock className={className} aria-hidden />;
  if (icon === "manual") return <LuMousePointer2 className={className} aria-hidden />;
  if (icon === "github") return <LuGithub className={className} aria-hidden />;
  if (icon === "webhook") return <LuWebhook className={className} aria-hidden />;
  if (icon === "email") return <LuMail className={className} aria-hidden />;
  return <LuRadio className={className} aria-hidden />;
}

export function TriggerSwitch({
  on,
  disabled,
  label,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 disabled:opacity-50 ${
        on ? "justify-end bg-[#ecedee]" : "justify-start bg-[#1a1c21]"
      }`}
    >
      <span
        className={`block size-3 rounded-full ${on ? "bg-[#0c0d0f]" : "bg-[#8b8f98]"}`}
      />
    </button>
  );
}

export function RunOutcomePill({ outcome }: { outcome: RunOutcome }) {
  const ok = outcome === "succeeded";
  return (
    <span
      className={`flex h-6 w-fit shrink-0 items-center gap-[5px] rounded-full px-2 ${
        ok ? "bg-[#4cc38a1a] text-[#4cc38a]" : "bg-[#f2645a1a] text-[#f2645a]"
      }`}
    >
      {ok ? (
        <LuCheck className="size-3" aria-hidden />
      ) : (
        <LuX className="size-3" aria-hidden />
      )}
      <span className="whitespace-nowrap text-xs font-medium">
        {ok ? "Succeeded" : "Failed"}
      </span>
    </span>
  );
}

export function TriggerListRow({
  trigger,
  selected,
  lastRun,
  now,
  toggling,
  firing,
  onSelect,
  onToggle,
  onFire,
}: {
  trigger: TriggerListItem;
  selected: boolean;
  lastRun: RunSummary | undefined;
  now: Date;
  toggling: boolean;
  firing: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onFire: () => void;
}) {
  const summary = triggerSummaryLine(trigger);
  const next = triggerNextCell(trigger, now);
  const fire = triggerFireState(trigger);
  const outcome = runOutcome(lastRun);
  const firedAt = trigger.last_fired_at ?? lastRun?.created_at;
  const lastMeta = [
    firedAt ? relativeTime(firedAt, now.getTime()) : undefined,
    trigger.last_run_id ? runShortId(trigger.last_run_id) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const icon = triggerSourceIcon(trigger);

  return (
    <div
      role="row"
      aria-selected={selected}
      data-trigger-id={trigger.id}
      onClick={onSelect}
      className={`flex h-14 w-full shrink-0 cursor-pointer items-center gap-2.5 border-b border-l-2 border-b-[#ffffff12] py-0 pl-3.5 pr-4 ${
        selected
          ? "border-l-[#ecedee] bg-[#131418]"
          : "border-l-transparent hover:bg-[#ffffff05]"
      }`}
    >
      <div className="flex w-5 shrink-0 justify-center">
        <TriggerSourceGlyph
          icon={icon}
          className={`size-4 ${selected ? "text-[#ecedee]" : "text-[#a7aab2]"}`}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          className={`min-w-0 truncate ${MONO} text-[13px] text-[#ecedee] ${
            selected ? "font-medium" : "font-normal"
          }`}
          title={trigger.id}
        >
          {trigger.id}
        </div>
        {summary.warning ? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-[#a7aab2]">
            <LuTriangleAlert className="size-3 shrink-0 text-[#f2a65a]" aria-hidden />
            <span className="min-w-0 truncate" title={summary.text}>
              {summary.text}
            </span>
          </div>
        ) : (
          <div className="min-w-0 truncate text-xs text-[#a7aab2]" title={summary.text}>
            {summary.text}
          </div>
        )}
      </div>
      <div className="flex w-[120px] min-w-0 shrink-0 flex-col gap-0.5">
        <div
          className={`min-w-0 truncate ${MONO} text-xs text-[#ecedee]`}
          title={trigger.pipeline}
        >
          {trigger.pipeline}
        </div>
        {trigger.task ? (
          <div
            className={`min-w-0 truncate ${MONO} text-[11px] text-[#8b8f98]`}
            title={trigger.task}
          >
            {trigger.task}
          </div>
        ) : (
          <span className="flex h-[18px] w-fit items-center rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-1.5 text-[11px] text-[#a7aab2]">
            dynamic task
          </span>
        )}
      </div>
      <div className="flex w-20 shrink-0 items-center gap-1.5">
        {next.dot ? (
          <span className="block size-1.5 shrink-0 rounded-full bg-[#4cc38a]" />
        ) : null}
        <span
          className={`truncate ${MONO} text-xs ${next.muted ? "text-[#8b8f98]" : "text-[#ecedee]"}`}
        >
          {next.label}
        </span>
      </div>
      <div className="flex w-[136px] shrink-0 flex-col gap-1">
        {outcome ? <RunOutcomePill outcome={outcome} /> : null}
        {lastMeta ? (
          <span className={`truncate ${MONO} text-[11px] text-[#8b8f98]`}>{lastMeta}</span>
        ) : (
          <span className={`${MONO} text-xs text-[#8b8f98]`}>never</span>
        )}
      </div>
      <div className="flex w-8 shrink-0">
        <TriggerSwitch
          on={trigger.enabled}
          disabled={toggling}
          label={trigger.enabled ? `Disable ${trigger.id}` : `Enable ${trigger.id}`}
          onToggle={onToggle}
        />
      </div>
      <div className="flex w-[60px] shrink-0 justify-end">
        <button
          type="button"
          disabled={!fire.enabled || firing}
          title={fire.title}
          onClick={(e) => {
            e.stopPropagation();
            onFire();
          }}
          className={`flex h-[26px] items-center gap-1.5 rounded-md px-2 ${
            fire.enabled ? "bg-[#1a1c21] text-[#ecedee]" : "cursor-not-allowed text-[#a7aab2]"
          }`}
        >
          <LuPlay className="size-3" aria-hidden />
          <span className="text-xs font-medium">Fire</span>
        </button>
      </div>
    </div>
  );
}
