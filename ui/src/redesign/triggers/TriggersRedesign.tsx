import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchPipelines,
  fetchTriggers,
  fireTrigger,
  patchTrigger,
  type RunSummary,
  type TriggerListItem,
} from "../../api";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { navigate, triggerPath } from "../../routes";
import { showToast } from "../../toast";
import { useHotkeys } from "../keys";
import {
  LuClock,
  LuFolder,
  LuInfo,
  LuMousePointer2,
  LuPlus,
  LuPowerOff,
  LuRadio,
  LuRows3,
  LuSearch,
  LuTriangleAlert,
} from "react-icons/lu";
import {
  filterTriggersByTab,
  groupTriggersByKind,
  type TriggerFilterTab,
} from "./triggerViews";
import { triggerMatchesQuery, triggerNeedsAttention } from "./triggerRowMeta";
import {
  duplicateTrigger,
  TRIGGER_GROUP_HINT,
  TRIGGER_GROUP_LABEL,
  TRIGGERS_INFO_NOTE,
  triggerFireState,
  triggerFolderLabel,
  type TriggerKind,
} from "./triggerListModel";
import { TriggersInspector, TriggersInspectorEmpty } from "./TriggersInspector";
import { NewTriggerModal } from "./NewTriggerModal";
import { TriggerListRow } from "./TriggerListRow";

const MONO = "font-['Geist_Mono',monospace]";
const HEAD_LABEL = "text-[11px] font-medium uppercase tracking-[0.88px] text-[#8b8f98]";
const TICK_MS = 30_000;

type ModalState = { mode: "create" | "edit"; initial: TriggerListItem | null } | null;

function KindGlyph({ kind, className }: { kind: TriggerKind; className: string }) {
  if (kind === "schedule") return <LuClock className={className} aria-hidden />;
  if (kind === "event") return <LuRadio className={className} aria-hidden />;
  return <LuMousePointer2 className={className} aria-hidden />;
}

function FooterKey({ children }: { children: ReactNode }) {
  return (
    <span
      className={`rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] ${MONO} text-[11px] text-[#a7aab2]`}
    >
      {children}
    </span>
  );
}

function FilterChip({
  active,
  label,
  count,
  icon,
  countClassName,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  icon?: ReactNode;
  countClassName?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 ${
        active ? "border border-[#ffffff1a] bg-[#1a1c21]" : "border border-transparent hover:bg-[#ffffff08]"
      }`}
    >
      {icon}
      <span
        className={`whitespace-nowrap text-[13px] ${
          active ? "font-medium text-[#ecedee]" : "text-[#a7aab2]"
        }`}
      >
        {label}
      </span>
      <span
        className={`${MONO} text-xs ${
          active ? "text-[#a7aab2]" : countClassName ?? "text-[#8b8f98]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

export function TriggersRedesign({ triggerId }: { triggerId?: string }) {
  const { snapshot } = useRunCatalog();
  const [triggers, setTriggers] = useState<TriggerListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TriggerFilterTab>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(triggerId ?? null);
  const [modal, setModal] = useState<ModalState>(null);
  const [stageCounts, setStageCounts] = useState<Map<string, number>>(new Map());
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [firingId, setFiringId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const t = await fetchTriggers();
      setTriggers(t.triggers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchPipelines().then(
      (result) => {
        if (cancelled) return;
        setStageCounts(new Map(result.pipelines.map((p) => [p.id, p.stages.length])));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (triggerId) setSelectedId(triggerId);
  }, [triggerId]);

  const groups = useMemo(() => {
    const byTab = filterTriggersByTab(triggers, tab).filter((t) =>
      triggerMatchesQuery(t, query),
    );
    return groupTriggersByKind(byTab);
  }, [triggers, tab, query]);

  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (loading) return;
    if (ordered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !ordered.some((t) => t.id === selectedId)) {
      setSelectedId(ordered[0]!.id);
    }
  }, [ordered, selectedId, loading]);

  const runsById = useMemo(() => {
    const map = new Map<string, RunSummary>();
    for (const run of snapshot.runs) map.set(run.run_id, run);
    return map;
  }, [snapshot.runs]);

  const selected = ordered.find((t) => t.id === selectedId) ?? null;
  const selectedIndex = selected ? ordered.indexOf(selected) : -1;
  const folder = triggerFolderLabel(triggers);
  const hostReady = !loading && !error;

  function selectTrigger(id: string) {
    setSelectedId(id);
    navigate(triggerPath(id));
  }

  async function onSaved(trigger: TriggerListItem) {
    const edited = modal?.mode === "edit";
    setModal(null);
    await load();
    showToast(`${edited ? "Trigger updated" : "Trigger created"} · ${trigger.id}`);
    selectTrigger(trigger.id);
  }

  async function toggleTrigger(trigger: TriggerListItem) {
    if (togglingId) return;
    setTogglingId(trigger.id);
    try {
      const updated = await patchTrigger(trigger.id, { enabled: !trigger.enabled });
      setTriggers((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingId(null);
    }
  }

  async function fireOne(trigger: TriggerListItem) {
    if (firingId || !triggerFireState(trigger).enabled) return;
    setFiringId(trigger.id);
    try {
      const result = await fireTrigger(trigger.id);
      showToast(
        result.queued
          ? `Trigger queued · ${trigger.id}`
          : `Trigger fired · ${trigger.id} · ${result.runId}`,
      );
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setFiringId(null);
    }
  }

  const tabCounts = useMemo(
    () => ({
      all: triggers.length,
      schedule: triggers.filter((t) => t.enabled && t.kind === "schedule").length,
      event: triggers.filter((t) => t.enabled && t.kind === "event").length,
      manual: triggers.filter((t) => t.enabled && t.kind === "manual").length,
      disabled: triggers.filter((t) => !t.enabled).length,
      needs_attention: triggers.filter((t) => triggerNeedsAttention(t)).length,
    }),
    [triggers],
  );

  useHotkeys(
    [
      {
        key: "n",
        scope: "triggers",
        handler: (e) => {
          e.preventDefault();
          setModal({ mode: "create", initial: null });
        },
      },
      {
        key: "/",
        scope: "triggers",
        handler: (e) => {
          e.preventDefault();
          searchRef.current?.focus();
        },
      },
      {
        key: "j",
        scope: "triggers",
        handler: () => {
          if (ordered.length === 0) return;
          const next = Math.min(
            selectedIndex < 0 ? 0 : selectedIndex + 1,
            ordered.length - 1,
          );
          selectTrigger(ordered[next]!.id);
        },
      },
      {
        key: "k",
        scope: "triggers",
        handler: () => {
          if (ordered.length === 0) return;
          const next = Math.max(selectedIndex <= 0 ? 0 : selectedIndex - 1, 0);
          selectTrigger(ordered[next]!.id);
        },
      },
      {
        key: "f",
        scope: "triggers",
        handler: (e) => {
          if (!selected || !triggerFireState(selected).enabled) return;
          e.preventDefault();
          void fireOne(selected);
        },
      },
      {
        key: "e",
        scope: "triggers",
        handler: (e) => {
          if (!selected) return;
          e.preventDefault();
          void toggleTrigger(selected);
        },
      },
    ],
    "triggers",
  );

  const showEmpty = !loading && triggers.length === 0 && !error;
  const showFilterEmpty = !loading && triggers.length > 0 && ordered.length === 0;

  const kindChips: Array<{ id: TriggerFilterTab; kind: TriggerKind; count: number }> = [
    { id: "schedule", kind: "schedule", count: tabCounts.schedule },
    { id: "event", kind: "event", count: tabCounts.event },
    { id: "manual", kind: "manual", count: tabCounts.manual },
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <header className="flex h-14 w-full shrink-0 items-center justify-between gap-4 border-b border-b-[#ffffff12] px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="whitespace-nowrap text-xl font-semibold tracking-[-0.4px] text-[#ecedee]">
            Triggers
          </h1>
          <span className={`${MONO} text-[13px] text-[#8b8f98]`}>{triggers.length}</span>
          {hostReady ? (
            <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[#ffffff12] bg-[#131418] px-2.5">
              <span className="block size-1.5 rounded-full bg-[#4cc38a] shadow-[0px_0px_6px_rgba(76,195,138,0.6)]" />
              <span className="whitespace-nowrap text-xs text-[#a7aab2]">
                Scheduler running · ticks every 30s
              </span>
            </span>
          ) : null}
          <span className="flex shrink-0 items-center gap-[5px]">
            <LuFolder className="size-3 text-[#8b8f98]" aria-hidden />
            <span className={`${MONO} whitespace-nowrap text-xs text-[#8b8f98]`}>{folder}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex h-8 w-[260px] items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5">
            <LuSearch className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
              placeholder="Search by id, pipeline or source"
              className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[#ecedee] outline-none placeholder:text-[#8b8f98]"
            />
            <span
              className={`rounded-sm border border-[#ffffff1a] bg-[#131418] px-[5px] ${MONO} text-[11px] text-[#8b8f98]`}
            >
              /
            </span>
          </label>
          <button
            type="button"
            onClick={() => setModal({ mode: "create", initial: null })}
            className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[#ecedee] px-3 text-[#0c0d0f]"
          >
            <LuPlus className="size-3.5" aria-hidden />
            <span className="whitespace-nowrap text-[13px] font-medium">New trigger</span>
            <span
              className={`rounded-sm border border-[#0c0d0f2e] px-[5px] ${MONO} text-[11px] text-[#5a5d66]`}
            >
              N
            </span>
          </button>
        </div>
      </header>

      <div className="flex h-12 w-full shrink-0 items-center justify-between border-b border-b-[#ffffff12] px-5">
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Trigger filters">
          <FilterChip
            active={tab === "all"}
            label="All"
            count={tabCounts.all}
            onClick={() => setTab("all")}
          />
          {kindChips.map((chip) => (
            <FilterChip
              key={chip.id}
              active={tab === chip.id}
              label={TRIGGER_GROUP_LABEL[chip.kind]}
              count={chip.count}
              icon={
                <KindGlyph
                  kind={chip.kind}
                  className={`size-[13px] ${tab === chip.id ? "text-[#ecedee]" : "text-[#a7aab2]"}`}
                />
              }
              onClick={() => setTab(chip.id)}
            />
          ))}
          <span className="mx-1.5 block h-4 w-px bg-[#ffffff12]" />
          <FilterChip
            active={tab === "disabled"}
            label="Disabled"
            count={tabCounts.disabled}
            icon={
              <LuPowerOff
                className={`size-[13px] ${tab === "disabled" ? "text-[#ecedee]" : "text-[#8b8f98]"}`}
                aria-hidden
              />
            }
            onClick={() => setTab("disabled")}
          />
          <FilterChip
            active={tab === "needs_attention"}
            label="Needs attention"
            count={tabCounts.needs_attention}
            countClassName={tabCounts.needs_attention > 0 ? "text-[#ecedee]" : undefined}
            icon={
              <LuTriangleAlert
                className={`size-[13px] ${
                  tab === "needs_attention" || tabCounts.needs_attention > 0
                    ? "text-[#ecedee]"
                    : "text-[#8b8f98]"
                }`}
                aria-hidden
              />
            }
            onClick={() => setTab("needs_attention")}
          />
        </div>
        <div className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg px-2.5">
          <LuRows3 className="size-[13px] text-[#8b8f98]" aria-hidden />
          <span className="text-[13px] text-[#8b8f98]">Group:</span>
          <span className="text-[13px] text-[#ecedee]">Kind</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-r border-r-[#ffffff12]">
          {error ? <p className="px-5 py-3 text-xs text-[#f2645a]">{error}</p> : null}
          {loading ? (
            <p className="px-5 py-3 text-xs text-[#8b8f98]">Loading triggers…</p>
          ) : null}
          {showEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-12">
              <p className="text-[13px] text-[#a7aab2]">No triggers in this catalog yet.</p>
              <button
                type="button"
                onClick={() => setModal({ mode: "create", initial: null })}
                className="flex h-8 items-center gap-2 rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f]"
              >
                <LuPlus className="size-3.5" aria-hidden />
                New trigger
              </button>
            </div>
          ) : null}
          {showFilterEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center px-5 py-12">
              <p className="text-[13px] text-[#a7aab2]">No triggers match this filter.</p>
            </div>
          ) : null}
          {!loading && ordered.length > 0 ? (
            <>
              <div className="flex h-8 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4">
                <span className="block w-5 shrink-0" />
                <span className={`${HEAD_LABEL} min-w-0 flex-1`}>Trigger</span>
                <span className={`${HEAD_LABEL} w-[120px] shrink-0`}>Target</span>
                <span className={`${HEAD_LABEL} w-20 shrink-0`}>Next run</span>
                <span className={`${HEAD_LABEL} w-[136px] shrink-0`}>Last fired</span>
                <span className={`${HEAD_LABEL} w-8 shrink-0`}>On</span>
                <span className="block w-[60px] shrink-0" />
              </div>
              <div role="grid" aria-label="Triggers">
                {groups.map((group) => (
                  <div key={group.kind} role="rowgroup">
                    <div className="flex h-8 w-full items-center gap-2 border-b border-b-[#ffffff12] px-4">
                      <KindGlyph kind={group.kind} className="size-[13px] text-[#a7aab2]" />
                      <span className="text-[13px] font-semibold text-[#ecedee]">
                        {TRIGGER_GROUP_LABEL[group.kind]}
                      </span>
                      <span className={`${MONO} text-xs text-[#8b8f98]`}>
                        {group.items.length}
                      </span>
                      <span className="truncate text-xs text-[#8b8f98]">
                        {TRIGGER_GROUP_HINT[group.kind]}
                      </span>
                    </div>
                    {group.items.map((trigger) => (
                      <TriggerListRow
                        key={trigger.id}
                        trigger={trigger}
                        selected={selectedId === trigger.id}
                        lastRun={
                          trigger.last_run_id ? runsById.get(trigger.last_run_id) : undefined
                        }
                        now={now}
                        toggling={togglingId === trigger.id}
                        firing={firingId === trigger.id}
                        onSelect={() => selectTrigger(trigger.id)}
                        onToggle={() => void toggleTrigger(trigger)}
                        onFire={() => void fireOne(trigger)}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <div className="flex items-start gap-2 px-4 py-3">
                <LuInfo className="mt-px size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                <p className="text-xs leading-[1.5] text-[#8b8f98]">{TRIGGERS_INFO_NOTE}</p>
              </div>
            </>
          ) : null}
        </div>
        {selected ? (
          <TriggersInspector
            trigger={selected}
            snapshot={snapshot}
            stageCount={stageCounts.get(selected.pipeline)}
            now={now}
            toggling={togglingId === selected.id}
            firing={firingId === selected.id}
            onToggle={() => void toggleTrigger(selected)}
            onFire={() => void fireOne(selected)}
            onEdit={() => setModal({ mode: "edit", initial: selected })}
            onDuplicate={() =>
              setModal({ mode: "create", initial: duplicateTrigger(selected) })
            }
          />
        ) : (
          <TriggersInspectorEmpty />
        )}
      </div>

      <footer className="flex h-8 w-full shrink-0 items-center gap-4 border-t border-t-[#ffffff12] bg-[#08090a] px-5 text-xs text-[#8b8f98]">
        <span className="flex items-center gap-1.5">
          <FooterKey>J</FooterKey>
          <span>/</span>
          <FooterKey>K</FooterKey>
          <span>move</span>
        </span>
        <span>·</span>
        <span className="flex items-center gap-1.5">
          <FooterKey>F</FooterKey>
          <span>fire</span>
        </span>
        <span>·</span>
        <span className="flex items-center gap-1.5">
          <FooterKey>E</FooterKey>
          <span>toggle</span>
        </span>
        <span>·</span>
        <span className="flex items-center gap-1.5">
          <FooterKey>N</FooterKey>
          <span>new trigger</span>
        </span>
        <span className="block flex-1" />
        {hostReady ? (
          <span className="flex items-center gap-1.5">
            <span className="block size-1.5 rounded-full bg-[#4cc38a]" />
            <span className={`${MONO} whitespace-nowrap text-[11px]`}>
              {triggers.length} files in {folder} · sf ui host running
            </span>
          </span>
        ) : null}
      </footer>

      <NewTriggerModal
        isOpen={modal !== null}
        mode={modal?.mode ?? "create"}
        initial={modal?.initial ?? null}
        existingIds={triggers.map((t) => t.id)}
        onClose={() => setModal(null)}
        onCreated={(t) => void onSaved(t)}
      />
    </div>
  );
}
