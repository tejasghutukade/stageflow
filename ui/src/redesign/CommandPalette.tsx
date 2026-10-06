import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchPipelines,
  fetchTasks,
  type PipelineListing,
  type RunSummary,
  type TaskListing,
} from "../api";
import { runTaskLabel } from "../catalog/displayCatalogPath";
import { relativeTime, runShortId } from "../catalogJoin";
import { useRunCatalog } from "../catalog/useRunCatalog";
import { bucketViews, inboxWaitingView } from "../catalog/views";
import { Keycap } from "./Keycap";
import { useHotkeys } from "./keys";
import {
  OVERLAY_SCRIM_CLASS,
  PALETTE_SCRIM_PT,
} from "./overlay/overlayScrimClasses";
import { useOverlayChrome } from "./overlay/useOverlayChrome";
import { buildPaletteIndex, groupPaletteItems } from "./palette/buildPaletteIndex";
import { PaletteStatusPill } from "./palette/PaletteStatusPill";
import type { PaletteGroup, PaletteItem } from "./palette/types";
import { runDisplayStatus } from "../status/runStatus";
import { statusSignalFromRun, runStatusPillLabel } from "./statusSignal";
import {
  LuHand,
  LuInbox,
  LuPlay,
  LuRotateCcw,
  LuSearch,
  LuSettings,
  LuWorkflow,
} from "react-icons/lu";

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
  onNavigate: (path: string) => void;
  onOpenStartRun: () => void;
};

const GROUP_LABEL: Record<PaletteGroup, string> = {
  actions: "Actions",
  runs: "Runs",
  pipelines: "Pipelines",
  navigation: "Navigation",
};

function paletteRunRef(runId: string): string {
  const short = runShortId(runId);
  return short.startsWith("run_") ? short : `run_${short}`;
}

export function CommandPalette({
  open,
  onClose,
  workspaceName,
  onNavigate,
  onOpenStartRun,
}: CommandPaletteProps) {
  const { snapshot } = useRunCatalog();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useOverlayChrome(open);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlight(0);
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void Promise.all([fetchTasks(), fetchPipelines()]).then(([t, p]) => {
      setTasks(t.tasks);
      setPipelines(p.pipelines);
    });
  }, [open]);

  const waiting = inboxWaitingView(snapshot);
  const broken = bucketViews(snapshot).broken;

  const items = useMemo(
    () =>
      buildPaletteIndex({
        snapshot,
        tasks,
        pipelines,
        query,
        ctx: {
          firstWaitingRunId: waiting[0]?.run_id,
          firstBrokenRunId: broken[0]?.run_id,
          onStartRun: () => {
            onClose();
            onOpenStartRun();
          },
          onNavigate: (path) => {
            onClose();
            onNavigate(path);
          },
        },
      }),
    [
      snapshot,
      tasks,
      pipelines,
      query,
      waiting,
      broken,
      onClose,
      onNavigate,
      onOpenStartRun,
    ],
  );

  const groups = useMemo(() => groupPaletteItems(items), [items]);

  useEffect(() => {
    setHighlight(0);
  }, [query, items.length]);

  useHotkeys(
    [
      {
        key: "arrowdown",
        scope: "global",
        when: () => open && items.length > 0,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          setHighlight((i) => (i + 1) % items.length);
        },
      },
      {
        key: "arrowup",
        scope: "global",
        when: () => open && items.length > 0,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          setHighlight((i) => (i - 1 + items.length) % items.length);
        },
      },
      {
        key: "enter",
        scope: "global",
        when: () => open && items.length > 0,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          items[highlight]?.run();
        },
      },
    ],
    "global",
  );

  if (!open) return null;

  const flatIndex = (item: PaletteItem) => items.findIndex((i) => i.id === item.id);

  const resultCountLabel =
    items.length === 1 ? "1 result" : `${items.length} results`;

  return createPortal(
    <div
      className={`${OVERLAY_SCRIM_CLASS} ${PALETTE_SCRIM_PT}`}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="flex w-[640px] min-w-0 max-h-[min(70vh,560px)] flex-col overflow-clip rounded-[14px] border border-[#ffffff1a] bg-[var(--sf-panel)] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-[52px] w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 py-0">
          <LuSearch className="size-4 shrink-0 text-[var(--sf-text-2)]" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search runs, pipelines, actions…"
            aria-autocomplete="list"
            className="min-w-0 flex-1 border-none bg-transparent font-sans text-[15px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
          />
          <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            {resultCountLabel}
          </span>
          <Keycap>esc</Keycap>
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-0 py-1.5"
          role="listbox"
        >
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center font-sans text-[13px] text-[var(--sf-text-3)]">
              No matches
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.group} className="flex w-full flex-col px-1.5 py-0">
                <div className="px-2.5 pb-1.5 pt-2 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  {GROUP_LABEL[group.group]}
                </div>
                {group.items.map((item) => {
                  const idx = flatIndex(item);
                  const selected = idx === highlight;
                  const runRow = snapshot.runs.find(
                    (r) => item.id === `run-${r.run_id}`,
                  );
                  const pipelineRow = pipelines.find(
                    (p) => item.id === `pipeline-${p.path}`,
                  );
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 py-0 text-left${
                        selected
                          ? " bg-[var(--sf-raised)] shadow-[inset_2px_0px_0px_rgb(236,237,238)]"
                          : ""
                      }${group.group === "runs" ? " gap-3" : ""}`}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => item.run()}
                    >
                      {renderPaletteRow({
                        item,
                        runRow,
                        pipelineRow,
                        waitingCount: waiting.length,
                      })}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <footer className="flex h-9 w-full shrink-0 items-center gap-2 border-t border-t-[#ffffff12] bg-[#101114] px-4 py-0">
          <span className="flex items-center gap-1.5">
            <Keycap>↑↓</Keycap>
            <span className="font-sans text-xs text-[var(--sf-text-3)]">navigate</span>
          </span>
          <span className="font-sans text-xs text-[var(--sf-text-3)]">·</span>
          <span className="flex items-center gap-1.5">
            <Keycap>↵</Keycap>
            <span className="font-sans text-xs text-[var(--sf-text-3)]">run</span>
          </span>
          <span className="font-sans text-xs text-[var(--sf-text-3)]">·</span>
          <span className="flex items-center gap-1.5">
            <Keycap>tab</Keycap>
            <span className="font-sans text-xs text-[var(--sf-text-3)]">filter by type</span>
          </span>
          <span className="block flex-1" />
          <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
            {workspaceName}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function renderPaletteRow({
  item,
  runRow,
  pipelineRow,
  waitingCount,
}: {
  item: PaletteItem;
  runRow?: RunSummary;
  pipelineRow?: PipelineListing;
  waitingCount: number;
}) {
  if (item.id === "action-retry-failed") {
    return (
      <>
        <LuRotateCcw className="size-4 shrink-0 text-[var(--sf-text-1)]" aria-hidden="true" />
        <span className="shrink-0 font-sans text-[13px] font-medium text-[var(--sf-text-1)]">
          {item.label}
        </span>
        {item.context ? (
          <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
            · {item.context}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <PaletteStatusPill signal="fail" label="Failed" />
      </>
    );
  }
  if (item.id === "action-start-run") {
    return (
      <>
        <LuPlay className="size-4 shrink-0 text-[var(--sf-text-2)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-sans text-[13px] text-[var(--sf-text-1)]">
          {item.label}
        </span>
      </>
    );
  }
  if (item.id === "action-answer-gate") {
    return (
      <>
        <LuHand className="size-4 shrink-0 text-[var(--sf-needs)]" aria-hidden="true" />
        <span className="shrink-0 font-sans text-[13px] text-[var(--sf-text-1)]">
          {item.label}
        </span>
        {item.context ? (
          <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
            · {item.context}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {waitingCount > 0 ? (
          <PaletteStatusPill
            signal="needs"
            label={waitingCount === 1 ? "1 waiting" : `${waitingCount} waiting`}
          />
        ) : null}
      </>
    );
  }
  if (item.group === "runs" && runRow) {
    const signal = statusSignalFromRun(runRow);
    const pill = runStatusPillLabel(runDisplayStatus(runRow));
    return (
      <>
        <PaletteStatusPill signal={signal} label={pill} />
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--sf-text-1)]">
          {runTaskLabel(runRow)}
        </span>
        <span className="w-[104px] shrink-0 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
          {runRow.pipeline_id}
        </span>
        <span className="w-[84px] shrink-0 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
          {paletteRunRef(runRow.run_id)}
        </span>
        {(() => {
          const raw = runRow.updated_at ?? runRow.created_at;
          if (!raw) return null;
          return (
            <span className="w-14 shrink-0 text-right font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
              {relativeTime(raw)}
            </span>
          );
        })()}
      </>
    );
  }
  if (item.group === "pipelines" && pipelineRow) {
    const stages = pipelineRow.stages.map((s) => s.id).join(" → ");
    return (
      <>
        <LuWorkflow className="size-4 shrink-0 text-[var(--sf-text-2)]" aria-hidden="true" />
        <span className="w-[110px] shrink-0 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)]">
          {pipelineRow.id}
        </span>
        <span className="min-w-0 flex-1 truncate font-sans text-xs text-[var(--sf-text-3)]">
          {stages}
        </span>
        <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
          {pipelineRow.stages.length} stages
        </span>
      </>
    );
  }
  if (item.group === "navigation") {
    const Icon =
      item.id === "nav-inbox"
        ? LuInbox
        : item.id === "nav-settings"
          ? LuSettings
          : LuPlay;
    return (
      <>
        <Icon className="size-4 shrink-0 text-[var(--sf-text-2)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-sans text-[13px] text-[var(--sf-text-1)]">
          Go to {item.label}
        </span>
      </>
    );
  }
  return (
    <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--sf-text-1)]">
      {item.label}
    </span>
  );
}
