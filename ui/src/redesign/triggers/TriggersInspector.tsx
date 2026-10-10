import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchTriggerFires,
  type RunSummary,
  type TriggerFireRecord,
  type TriggerListItem,
} from "../../api";
import type { CatalogSnapshot } from "../../catalog/source";
import { relativeTime } from "../../catalogJoin";
import { runStreamPath } from "../../routes";
import { showToast } from "../../toast";
import {
  LuArrowRight,
  LuChevronRight,
  LuCopy,
  LuFileCode,
  LuInfo,
  LuPencil,
  LuPlay,
  LuPowerOff,
} from "react-icons/lu";
import { RunOutcomePill, TriggerSourceGlyph, TriggerSwitch } from "./TriggerListRow";
import {
  formatCost,
  formatRelativeFuture,
  formatRunDate,
  humanizeCron,
  runDuration,
  runOutcome,
  safeNextRuns,
  triggerBehaviorNotes,
  triggerEventFields,
  triggerFilePath,
  triggerFireState,
  triggerMatchSummary,
  triggerSourceIcon,
} from "./triggerListModel";

const MONO = "font-['Geist_Mono',monospace]";
const LABEL =
  "text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]";
const MAX_FIRES = 8;

type FiresState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; fires: TriggerFireRecord[] };

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-1.5 border-b border-b-[#ffffff12] px-4 py-2.5">
      <div className={LABEL}>{label}</div>
      {children}
    </div>
  );
}

export function TriggersInspectorEmpty() {
  return (
    <aside className="flex w-[420px] min-w-0 shrink-0 items-center justify-center bg-[#131418]">
      <p className="text-[13px] text-[#8b8f98]">Select a trigger</p>
    </aside>
  );
}

export function TriggersInspector({
  trigger,
  snapshot,
  stageCount,
  now,
  toggling,
  firing,
  onToggle,
  onFire,
  onEdit,
  onDuplicate,
}: {
  trigger: TriggerListItem;
  snapshot: CatalogSnapshot;
  stageCount: number | undefined;
  now: Date;
  toggling: boolean;
  firing: boolean;
  onToggle: () => void;
  onFire: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  const [fires, setFires] = useState<FiresState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setFires({ status: "loading" });
    fetchTriggerFires(trigger.id).then(
      (result) => {
        if (cancelled) return;
        setFires({
          status: "ready",
          fires: Array.isArray(result.fires) ? result.fires : [],
        });
      },
      () => {
        if (!cancelled) setFires({ status: "unavailable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [trigger.id, trigger.last_fired_at]);

  const runsById = useMemo(() => {
    const map = new Map<string, RunSummary>();
    for (const run of snapshot.runs) map.set(run.run_id, run);
    return map;
  }, [snapshot.runs]);

  const fire = triggerFireState(trigger);
  const lastRun = trigger.last_run_id ? runsById.get(trigger.last_run_id) : undefined;
  const lastOutcome = runOutcome(lastRun);
  const lastDuration = runDuration(lastRun);
  const lastCost = formatCost(lastRun?.total_cost_usd);
  const lastFiredAt = trigger.last_fired_at ?? lastRun?.created_at;
  const nextRuns =
    trigger.kind === "schedule" && trigger.task ? safeNextRuns(trigger, now, 4) : [];
  const eventFields = triggerEventFields(trigger);
  const matchSummary = triggerMatchSummary(trigger);
  const cliLine = `sf trigger fire ${trigger.id}`;

  async function copyCli() {
    try {
      await navigator.clipboard.writeText(cliLine);
      showToast("Copied");
    } catch {
      showToast("Copy failed");
    }
  }

  return (
    <aside className="flex w-[420px] min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-[#131418]">
      <div className="flex w-full shrink-0 flex-col gap-1 border-b border-b-[#ffffff12] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className={`${LABEL} flex-1`}>Trigger</div>
          <button
            type="button"
            onClick={onEdit}
            className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-[#a7aab2] hover:bg-[#1a1c21]"
          >
            <LuPencil className="size-3" aria-hidden />
            <span className="text-xs font-medium">Edit</span>
          </button>
          <div className="flex items-center gap-1.5 pl-1">
            <span className="text-xs text-[#a7aab2]">Enabled</span>
            <TriggerSwitch
              on={trigger.enabled}
              disabled={toggling}
              label={trigger.enabled ? "Disable trigger" : "Enable trigger"}
              onToggle={onToggle}
            />
          </div>
        </div>
        <h2 className={`${MONO} truncate text-[15px] font-semibold text-[#ecedee]`}>
          {trigger.id}
        </h2>
        <div className="flex min-w-0 items-center gap-1.5">
          <LuFileCode className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
          <span className={`${MONO} truncate text-xs text-[#8b8f98]`}>
            {triggerFilePath(trigger)}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="grid w-full grid-cols-[84px_1fr] items-center gap-x-3 gap-y-2 border-b border-b-[#ffffff12] px-4 py-3">
          <div className={LABEL}>Kind</div>
          <div className="flex h-[22px] w-fit items-center gap-1.5 rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-1.5">
            <TriggerSourceGlyph
              icon={triggerSourceIcon(trigger)}
              className="size-3 text-[#a7aab2]"
            />
            <span className={`${MONO} text-xs text-[#ecedee]`}>{trigger.kind}</span>
          </div>
          {trigger.kind === "schedule" && trigger.schedule ? (
            <>
              <div className={LABEL}>Cron</div>
              <div className="flex min-w-0 items-center gap-2">
                <span className={`${MONO} whitespace-nowrap text-[13px] text-[#ecedee]`}>
                  {trigger.schedule.cron}
                </span>
                <span className="truncate text-[13px] text-[#a7aab2]">
                  {humanizeCron(trigger.schedule.cron)}
                </span>
              </div>
              <div className={LABEL}>Timezone</div>
              <div className={`${MONO} text-xs text-[#ecedee]`}>
                {trigger.schedule.timezone ?? "local"}
              </div>
            </>
          ) : null}
          {trigger.kind === "event" ? (
            <>
              <div className={LABEL}>Source</div>
              <div className={`${MONO} truncate text-xs text-[#ecedee]`}>
                {trigger.event?.source ?? "—"}
              </div>
              {eventFields.map(([key, value]) => (
                <FieldRow key={key} label={key} value={value} />
              ))}
              {matchSummary ? <FieldRow label="Match" value={matchSummary} /> : null}
            </>
          ) : null}
        </div>
        {trigger.kind === "manual" ? (
          <div className="border-b border-b-[#ffffff12] px-4 py-2.5 text-[13px] text-[#a7aab2]">
            Fires only when you run it.
          </div>
        ) : null}

        {nextRuns.length > 0 ? (
          <Section label="Next runs">
            <div className="grid w-full grid-cols-[minmax(0px,1fr)_minmax(0px,1fr)] gap-x-3 gap-y-1">
              {nextRuns.map((date, index) => (
                <div
                  key={date.toISOString()}
                  className="flex items-center justify-between gap-2"
                >
                  <span
                    className={`${MONO} whitespace-nowrap text-xs ${
                      index === 0 ? "text-[#ecedee]" : "text-[#a7aab2]"
                    }`}
                  >
                    {formatRunDate(date)}
                  </span>
                  <span
                    className={`${MONO} whitespace-nowrap text-[11px] ${
                      index === 0 ? "text-[#a7aab2]" : "text-[#8b8f98]"
                    }`}
                  >
                    {formatRelativeFuture(date, now)}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        <div className="flex w-full flex-col gap-2 border-b border-b-[#ffffff12] px-4 py-2.5">
          <div className={LABEL}>Target</div>
          <div className="flex items-center gap-3">
            <span className="w-[60px] shrink-0 text-xs text-[#8b8f98]">pipeline</span>
            <span className={`${MONO} shrink-0 text-[13px] text-[#ecedee]`}>
              {trigger.pipeline}
            </span>
            {stageCount !== undefined && stageCount > 0 ? (
              <>
                <span className="flex flex-1 gap-[3px]">
                  {Array.from({ length: stageCount }, (_, i) => (
                    <span key={i} className="block h-1.5 flex-1 rounded-full bg-[#4cc38a]" />
                  ))}
                </span>
                <span className={`${MONO} shrink-0 whitespace-nowrap text-[11px] text-[#8b8f98]`}>
                  {stageCount} {stageCount === 1 ? "stage" : "stages"}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <span className="w-[60px] shrink-0 text-xs text-[#8b8f98]">task</span>
            {trigger.task ? (
              <>
                <span className={`${MONO} truncate text-[13px] text-[#ecedee]`}>
                  {trigger.task}
                </span>
                <TagChip>catalog task</TagChip>
              </>
            ) : (
              <TagChip>dynamic task</TagChip>
            )}
          </div>
        </div>

        <Section label="Last fired">
          {trigger.last_run_id ? (
            <a
              href={`#${runStreamPath(trigger.last_run_id)}`}
              className="flex h-9 items-center gap-2 rounded-lg border border-[#ffffff12] bg-[#1a1c21] px-2.5 hover:border-[#ffffff26]"
            >
              {lastFiredAt ? (
                <span className={`${MONO} whitespace-nowrap text-xs text-[#a7aab2]`}>
                  {relativeTime(lastFiredAt, now.getTime())}
                </span>
              ) : null}
              <LuArrowRight className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
              <span className={`${MONO} min-w-0 truncate text-xs text-[#ecedee]`}>
                {trigger.last_run_id}
              </span>
              {lastOutcome ? <RunOutcomePill outcome={lastOutcome} /> : null}
              <span className="block flex-1" />
              {lastDuration ? (
                <span className={`${MONO} whitespace-nowrap text-xs text-[#a7aab2]`}>
                  {lastDuration}
                </span>
              ) : null}
              {lastCost ? (
                <span className={`${MONO} whitespace-nowrap text-xs text-[#ecedee]`}>
                  {lastCost}
                </span>
              ) : null}
              <LuChevronRight className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
            </a>
          ) : lastFiredAt ? (
            <span className={`${MONO} text-xs text-[#a7aab2]`}>
              {relativeTime(lastFiredAt, now.getTime())}
            </span>
          ) : (
            <span className="text-xs text-[#8b8f98]">Never fired</span>
          )}
          <div className="flex flex-col gap-0.5 pt-0.5">
            {triggerBehaviorNotes(trigger.kind).map((note) => (
              <div key={note} className="flex items-start gap-1.5">
                <LuInfo className="mt-0.5 size-3 shrink-0 text-[#8b8f98]" aria-hidden />
                <span className="text-xs leading-[1.4] text-[#8b8f98]">{note}</span>
              </div>
            ))}
          </div>
        </Section>

        <div className="flex w-full flex-col gap-1.5 px-4 py-2.5">
          <div className={LABEL}>Recent fires</div>
          {fires.status === "loading" ? (
            <p className="text-xs text-[#8b8f98]">Loading…</p>
          ) : fires.status === "unavailable" ? (
            <p className="text-xs text-[#8b8f98]">Fire history isn't available yet</p>
          ) : (
            <div className="flex w-full flex-col rounded-lg border border-dashed border-[#ffffff1a]">
              {fires.fires.length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-[#8b8f98]">No fires yet</p>
              ) : (
                fires.fires.slice(0, MAX_FIRES).map((record, index, list) => {
                  const run = runsById.get(record.run_id);
                  const outcome = runOutcome(run);
                  const duration = runDuration(run);
                  const parsed = new Date(record.fired_at);
                  return (
                    <div
                      key={`${record.run_id}-${record.fired_at}`}
                      className={`flex h-8 items-center gap-2.5 px-2.5 ${
                        index < list.length - 1 ? "border-b border-b-[#ffffff0d]" : ""
                      }`}
                    >
                      <span
                        className={`${MONO} w-[104px] shrink-0 whitespace-nowrap text-xs text-[#a7aab2]`}
                      >
                        {Number.isFinite(parsed.getTime())
                          ? formatRunDate(parsed)
                          : record.fired_at}
                      </span>
                      <a
                        href={`#${runStreamPath(record.run_id)}`}
                        className={`${MONO} min-w-0 flex-1 truncate text-xs text-[#ecedee] hover:underline`}
                      >
                        {record.run_id}
                      </a>
                      {outcome ? <RunOutcomePill outcome={outcome} /> : null}
                      {duration ? (
                        <span
                          className={`${MONO} w-12 shrink-0 whitespace-nowrap text-right text-xs text-[#a7aab2]`}
                        >
                          {duration}
                        </span>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex w-full shrink-0 flex-col gap-2 border-t border-t-[#ffffff12] px-4 py-2.5">
        <div className="flex w-full items-center gap-1.5">
          <button
            type="button"
            disabled={!fire.enabled || firing}
            title={fire.title}
            onClick={onFire}
            className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-[#ecedee] px-3 text-[#0c0d0f] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LuPlay className="size-3.5" aria-hidden />
            <span className="text-[13px] font-medium">{firing ? "Firing…" : "Fire now"}</span>
            <span
              className={`${MONO} rounded-sm border border-[#0c0d0f2e] px-[5px] text-[11px] text-[#5a5d66]`}
            >
              F
            </span>
          </button>
          <button
            type="button"
            onClick={onDuplicate}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3"
          >
            <LuCopy className="size-3.5 text-[#a7aab2]" aria-hidden />
            <span className="text-[13px] font-medium text-[#ecedee]">Duplicate</span>
          </button>
          <button
            type="button"
            disabled={toggling}
            onClick={onToggle}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[#a7aab2] hover:bg-[#1a1c21] disabled:opacity-50"
          >
            <LuPowerOff className="size-3.5" aria-hidden />
            <span className="text-[13px] font-medium">
              {trigger.enabled ? "Disable" : "Enable"}
            </span>
          </button>
        </div>
        <div className="flex h-8 w-full items-center gap-2 rounded-lg border border-[#ffffff12] bg-[#0c0d0f] px-2.5">
          <span className={`${MONO} text-xs text-[#8b8f98]`}>$</span>
          <span className={`${MONO} min-w-0 flex-1 truncate text-xs text-[#ecedee]`}>
            {cliLine}
          </span>
          <button
            type="button"
            aria-label="Copy command"
            onClick={() => void copyCli()}
            className="flex size-5 shrink-0 items-center justify-center text-[#8b8f98] hover:text-[#ecedee]"
          >
            <LuCopy className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className={`${LABEL} truncate`}>{label}</div>
      <div className={`${MONO} truncate text-xs text-[#ecedee]`} title={value}>
        {value}
      </div>
    </>
  );
}

function TagChip({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-1.5 text-[11px] text-[#a7aab2]">
      {children}
    </span>
  );
}
