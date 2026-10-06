import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTriggers, type TriggerListItem } from "../../api";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { triggerPath } from "../../routes";
import { navigate } from "../../routes";
import { showToast } from "../../toast";
import { PageHeader } from "../shell/PageHeader";
import { FilterTabs } from "../shell/FilterTabs";
import { Inspector } from "../shell/Inspector";
import { Keycap } from "../Keycap";
import { useHotkeys } from "../keys";
import { LuFolder, LuPlus, LuSearch } from "react-icons/lu";
import {
  filterTriggersByTab,
  type TriggerFilterTab,
} from "./triggerViews";
import { triggerMatchesQuery, triggerNeedsAttention } from "./triggerRowMeta";
import { TriggersInspector } from "./TriggersInspector";
import { NewTriggerModal } from "./NewTriggerModal";
import { TriggerListRow } from "./TriggerListRow";

export function TriggersRedesign({ triggerId }: { triggerId?: string }) {
  const { snapshot } = useRunCatalog();
  const [triggers, setTriggers] = useState<TriggerListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TriggerFilterTab>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(triggerId ?? null);
  const [modalOpen, setModalOpen] = useState(false);
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
    if (triggerId) setSelectedId(triggerId);
  }, [triggerId]);

  const filtered = useMemo(() => {
    const byTab = filterTriggersByTab(triggers, tab);
    return byTab
      .filter((t) => triggerMatchesQuery(t, query))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [triggers, tab, query]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((t) => t.id === selectedId)) {
      setSelectedId(filtered[0]!.id);
    }
  }, [filtered, selectedId]);

  function selectTrigger(id: string) {
    setSelectedId(id);
    navigate(triggerPath(id));
  }

  async function onCreated(trigger: TriggerListItem) {
    setModalOpen(false);
    await load();
    showToast(`Trigger created · ${trigger.id}`);
    selectTrigger(trigger.id);
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

  const selectedIndex = filtered.findIndex((t) => t.id === selectedId);

  useHotkeys(
    [
      {
        key: "n",
        scope: "triggers",
        handler: (e) => {
          e.preventDefault();
          setModalOpen(true);
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
          if (filtered.length === 0) return;
          const next = Math.min(
            selectedIndex < 0 ? 0 : selectedIndex + 1,
            filtered.length - 1,
          );
          selectTrigger(filtered[next]!.id);
        },
      },
      {
        key: "k",
        scope: "triggers",
        handler: () => {
          if (filtered.length === 0) return;
          const next = Math.max(selectedIndex <= 0 ? 0 : selectedIndex - 1, 0);
          selectTrigger(filtered[next]!.id);
        },
      },
    ],
    "triggers",
  );

  const showEmpty =
    !loading && triggers.length === 0 && !error;
  const showFilterEmpty =
    !loading && triggers.length > 0 && filtered.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        variant="inbox"
        title="Triggers"
        titleAddon={
          <>
            <span className="font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-3)]">
              {triggers.length}
            </span>
            <span className="flex shrink-0 items-center gap-[5px]">
              <LuFolder className="size-3 text-[var(--sf-text-3)]" aria-hidden />
              <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                triggers/
              </span>
            </span>
          </>
        }
        actions={
          <>
            <label
              className="flex h-8 w-[260px] items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5"
            >
              <LuSearch className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by id, pipeline or source"
                className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
              />
              <Keycap>/</Keycap>
            </label>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)]"
              onClick={() => setModalOpen(true)}
            >
              <LuPlus className="size-3.5" aria-hidden />
              New trigger
              <Keycap className="border-[#0c0d0f2e] text-[#5a5d66]">N</Keycap>
            </button>
          </>
        }
      />
      <FilterTabs
        activeId={tab}
        onChange={(id) => setTab(id as TriggerFilterTab)}
        tabs={[
          { id: "all", label: "All", count: tabCounts.all },
          { id: "schedule", label: "Schedule", count: tabCounts.schedule },
          { id: "event", label: "Event", count: tabCounts.event },
          { id: "manual", label: "Manual", count: tabCounts.manual },
          { id: "disabled", label: "Disabled", count: tabCounts.disabled },
          ...(tabCounts.needs_attention > 0
            ? [
                {
                  id: "needs_attention",
                  label: "Needs attention",
                  count: tabCounts.needs_attention,
                },
              ]
            : []),
        ]}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-r-[#ffffff12]">
          {error ? (
            <p className="px-5 py-3 text-[12px] text-[var(--sf-fail)]">{error}</p>
          ) : null}
          {loading ? (
            <p className="px-5 py-3 text-[12px] text-[var(--sf-text-3)]">
              Loading triggers…
            </p>
          ) : null}
          {showEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-12">
              <p className="text-[13px] text-[var(--sf-text-2)]">
                No triggers in this catalog yet.
              </p>
              <button
                type="button"
                className="sf-btn sf-btn--primary"
                onClick={() => setModalOpen(true)}
              >
                New trigger
              </button>
            </div>
          ) : null}
          {showFilterEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center px-5 py-12">
              <p className="text-[13px] text-[var(--sf-text-2)]">
                No triggers match this filter.
              </p>
            </div>
          ) : null}
          {!loading && filtered.length > 0 ? (
            <>
              <div className="flex h-8 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4">
                <span className="block w-5 shrink-0" />
                <span className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  Trigger
                </span>
                <span className="w-[120px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  Target
                </span>
                <span className="w-20 shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  Next
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  State
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {filtered.map((trigger) => (
                  <TriggerListRow
                    key={trigger.id}
                    trigger={trigger}
                    selected={selectedId === trigger.id}
                    onClick={() => selectTrigger(trigger.id)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
        {selectedId ? (
          <TriggersInspector
            triggerId={selectedId}
            snapshot={snapshot}
            onRefreshList={load}
          />
        ) : (
          <Inspector className="w-[420px]">
            <p className="text-[13px] text-[var(--sf-text-3)]">
              Select a trigger to inspect it.
            </p>
          </Inspector>
        )}
      </div>
      <NewTriggerModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(t) => void onCreated(t)}
      />
    </div>
  );
}
