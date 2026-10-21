import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LuChevronRight, LuClock, LuCopy, LuGlobe, LuMessageSquare, LuCircle, LuPlus, LuSearch, LuTriangleAlert } from "react-icons/lu";
import { agentsApi, type AgentSummary } from "../../api/agents";
import { agentPath } from "../../routes";
import { loadChannelMeta } from "../connections/channelMeta";
import { fetchChannelConnections } from "../../api";
import {
  directoryFooterText,
  directoryHint,
  directoryTotals,
  filterAgents,
  filterCounts,
  searchAgents,
  toDirectoryRow,
  type AgentDirectoryFilter,
  type AgentDirectoryRow,
} from "./agentsDirectoryModel";
import { Dialog } from "./editor/Dialogs";
import { clampCursor, isCursorKey, moveCursor, shouldHandleCursorKey } from "./listCursor";
import { MONO, NOWRAP, PAGE_BG } from "./agentsTokens";
import { PageHeader as ShellPageHeader } from "../shell/PageHeader";
import { Button, PageFooter } from "./ui";

const GRID =
  "grid grid-cols-[minmax(0,1fr)_170px_200px_210px_120px_130px_120px_14px] items-center gap-4 px-4 min-w-[1200px]";

const FILTERS: { id: AgentDirectoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  { id: "needs_setup", label: "Needs setup" },
];

function FilterChip({
  id,
  active,
  label,
  count,
  onClick,
}: {
  id: AgentDirectoryFilter;
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  const tone = active
    ? "border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
    : `border-transparent ${id === "needs_setup" && count > 0 ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-2)]"} hover:text-[var(--sf-text-1)]`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-2 py-0.5 text-xs leading-[1.33333] ${NOWRAP} ${tone}`}
    >
      {label} {count}
    </button>
  );
}

function StatusCell({ row }: { row: AgentDirectoryRow }) {
  const pill =
    row.statusTone === "ok"
      ? "border-[var(--sf-ok)] bg-[#3fb9500f] text-[var(--sf-ok)]"
      : row.statusTone === "needs"
        ? "border-[#f5b54459] bg-[#f5b5440a] text-[var(--sf-needs)]"
        : "border-[var(--sf-hairline-strong)] text-[var(--sf-text-3)]";
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs leading-[1.33333] ${pill}`}>
        {row.statusTone === "ok" ? (
          <span aria-hidden className="size-1.5 rounded-full bg-[var(--sf-ok)]" />
        ) : row.statusTone === "needs" ? (
          <LuTriangleAlert aria-hidden className="size-3 shrink-0" />
        ) : (
          <LuCircle aria-hidden className="size-3 shrink-0" />
        )}
        {row.statusLabel}
      </span>
      <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">{row.statusNote}</span>
    </div>
  );
}

function ReachCell({ row }: { row: AgentDirectoryRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="agent-reach">
      {row.reach.map((item) => (
        <div key={`${item.kind}-${item.detail ?? ""}`} className="flex min-w-0 flex-col">
          <span className={`flex min-w-0 items-center gap-1.5 text-xs leading-[1.33333] ${item.kind === "console" ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-1)]"}`}>
            {item.kind === "web" ? <LuGlobe aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" /> : null}
            {item.kind === "channel" ? <LuMessageSquare aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" /> : null}
            {item.kind === "schedule" ? <LuClock aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" /> : null}
            <span className="truncate">{item.label}</span>
            {item.idle && item.kind !== "console" ? <span className="text-[11px] text-[var(--sf-text-3)]">· off</span> : null}
          </span>
          {item.href ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className={`${MONO} relative z-10 min-w-0 truncate text-[11px] leading-normal text-[var(--sf-text-2)] underline decoration-[var(--sf-hairline-strong)] hover:text-[var(--sf-text-1)]`}
                title={item.href}
              >
                {item.detail}
              </a>
              <button
                type="button"
                aria-label="Copy chat link"
                title="Copy chat link"
                className="relative z-10 shrink-0 text-[var(--sf-text-3)] hover:text-[var(--sf-text-1)]"
                onClick={() => void navigator.clipboard?.writeText(item.href!)}
              >
                <LuCopy aria-hidden className="size-3" />
              </button>
            </span>
          ) : item.detail ? (
            <span className={`${MONO} truncate text-[11px] leading-normal text-[var(--sf-text-3)]`}>{item.detail}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function hasAccessDetail(row: AgentDirectoryRow): boolean {
  const { access } = row;
  return row.approvalsMore > 0 || access.builtin.length > 3 || access.mcpServers.length + access.skills.length > 0;
}

function AccessList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">{title}</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span key={item} className={`${MONO} rounded-md border border-[var(--sf-hairline-strong)] px-1.5 py-0.5 text-xs text-[var(--sf-text-1)]`}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function AccessDialog({ row, onClose }: { row: AgentDirectoryRow; onClose: () => void }) {
  const { access } = row;
  return (
    <Dialog title={`${row.name}: tools and approvals`} onClose={onClose} narrow>
      <div className="flex flex-col gap-4 px-4 py-4">
        <AccessList title="Built-in tools" items={[...access.builtin, ...(access.browser ? ["browser"] : [])]} />
        <AccessList title="MCP servers" items={access.mcpServers} />
        <AccessList title="Skills" items={access.skills} />
        <AccessList title="Asks first" items={access.askFirst} />
        {access.builtin.length + access.mcpServers.length + access.skills.length === 0 && !access.browser ? (
          <p className="text-[13px] text-[var(--sf-text-2)]">This agent has no tools.</p>
        ) : null}
        {access.askFirst.length === 0 ? <p className="text-[13px] text-[var(--sf-text-2)]">No approvals required.</p> : null}
      </div>
    </Dialog>
  );
}

function DirectoryRowView({
  row,
  highlighted,
  rowRef,
  onFocusRow,
  onShowAccess,
}: {
  row: AgentDirectoryRow;
  highlighted: boolean;
  rowRef: (node: HTMLAnchorElement | null) => void;
  onFocusRow: () => void;
  onShowAccess: () => void;
}) {
  const dim = !row.enabled && !row.needsSetup;
  return (
    <div
      className={`${GRID} relative py-3 ${dim ? "opacity-60" : ""} hover:bg-[var(--sf-panel)] focus-within:bg-[var(--sf-panel)] ${
        highlighted ? "bg-[var(--sf-panel)]" : ""
      }`}
    >
      {/* The whole row is one link (cmd-click works); the inner controls sit above it. */}
      <a
        ref={rowRef}
        href={`#${agentPath(row.id)}`}
        data-list-row=""
        aria-label={`Open ${row.name}`}
        className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--sf-hairline-strong)]"
        onFocus={onFocusRow}
        onKeyDown={(event) => {
          // Links only answer Enter; rows answer Space too.
          if (event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={`truncate text-[13px] font-medium leading-normal ${
            dim ? "text-[var(--sf-text-2)]" : "text-[var(--sf-text-1)]"
          }`}
        >
          {row.name}
        </span>
        {row.description ? (
          <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{row.description}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={`${MONO} break-words text-xs leading-[1.33333] ${
            row.modelIsDefault ? "text-[var(--sf-text-2)]" : "text-[var(--sf-text-1)]"
          }`}
        >
          {row.model}
        </span>
        <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">{row.backend}</span>
      </div>
      <ReachCell row={row} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs leading-[1.33333] text-[var(--sf-text-2)]">{row.toolsLine}</span>
        <span
          className={`text-[11px] leading-normal ${
            row.approvalsTone === "needs" ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-3)]"
          }`}
        >
          {row.approvalsLine}
          {row.approvalsMore > 0 ? ` +${row.approvalsMore}` : ""}
        </span>
        {hasAccessDetail(row) ? (
          <button
            type="button"
            className="relative z-10 w-fit text-[11px] leading-normal text-[var(--sf-text-2)] underline decoration-[var(--sf-hairline-strong)] hover:text-[var(--sf-text-1)]"
            onClick={onShowAccess}
          >
            View all
          </button>
        ) : null}
      </div>
      <StatusCell row={row} />
      <div className="flex flex-col gap-0.5">
        <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)]`}>{row.last7Days}</span>
        <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)]`}>{row.costLabel} all time</span>
      </div>
      <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{row.activityLabel}</span>
      <LuChevronRight aria-hidden className="size-3.5 text-[var(--sf-text-3)]" />
    </div>
  );
}

export function AgentsDirectoryPage({ onNewAgent }: { onNewAgent: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AgentDirectoryFilter>("all");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<string, string>>({});
  const rowRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, approvals] = await Promise.all([agentsApi.list(), agentsApi.pendingApprovals().catch(() => [])]);
      setAgents(list);
      setPending(approvals.length);
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

  // Connection id -> provider label ("iMessage", "Email"...), so a channel agent reads as what it is.
  useEffect(() => {
    let live = true;
    void Promise.all([fetchChannelConnections(), loadChannelMeta()]).then(
      ([result, meta]) => {
        if (!live) return;
        const labels: Record<string, string> = {};
        for (const connection of result.connections) {
          labels[connection.id] = meta.providers.find((p) => p.id === connection.provider)?.label ?? connection.provider;
        }
        setProviders(labels);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const counts = useMemo(() => filterCounts(agents), [agents]);
  const rows = useMemo(() => {
    const filtered = filterAgents(agents, filter);
    const providerOf = (id: string) => providers[id];
    const searched = searchAgents(filtered, search, providerOf);
    return searched.map((agent) => toDirectoryRow(agent, Date.now(), providerOf));
  }, [agents, filter, search, providers]);

  const noAgents = !loading && !error && counts.all === 0;
  const hint = directoryHint(agents);
  const totals = directoryTotals(agents);

  // A different list starts with no highlighted row.
  useEffect(() => {
    setCursor(-1);
  }, [filter, search]);
  useEffect(() => {
    setCursor((current) => clampCursor(current, rows.length));
  }, [rows.length]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isCursorKey(event.key) || !shouldHandleCursorKey(event.target as HTMLElement)) return;
    if (rows.length === 0) return;
    event.preventDefault();
    const next = moveCursor(cursor, event.key, rows.length);
    setCursor(next);
    rowRefs.current[next]?.focus();
  }

  return (
    <div className={PAGE_BG} onKeyDown={onKeyDown}>
      <ShellPageHeader
        title="Agents"
        titleAddon={<span className={`${MONO} text-[13px] text-[var(--sf-text-2)]`}>{agents.length}</span>}
        actions={
          <Button variant="primary" icon={<LuPlus aria-hidden />} onClick={onNewAgent}>
            New agent
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
        <p className="text-[13px] leading-normal text-[var(--sf-text-2)]">
          Agents defined in this project. Each one runs sealed, with only the tools and approvals you give it.
        </p>

        {pending > 0 ? (
          <div
            className="flex items-center gap-2.5 rounded-lg border border-[#f5b54459] bg-[#f5b5440a] px-4 py-3 text-[13px] leading-normal text-[var(--sf-text-1)]"
            data-testid="agents-pending-approvals"
          >
            <LuTriangleAlert aria-hidden className="size-4 shrink-0 text-[var(--sf-needs)]" />
            {pending} approval{pending === 1 ? "" : "s"} waiting on you
            <span className="text-[var(--sf-text-2)]">Open an agent with a waiting session to decide.</span>
          </div>
        ) : null}

        {error ? (
          <div
            className="flex items-center gap-2.5 rounded-lg border border-[#f5b54459] bg-[#f5b5440a] px-4 py-3 text-[13px] leading-normal text-[var(--sf-text-1)]"
            role="alert"
          >
            <LuTriangleAlert aria-hidden className="size-4 shrink-0 text-[var(--sf-needs)]" />
            Could not load agents
            <span className="text-[var(--sf-text-2)]">{error}</span>
          </div>
        ) : null}

        {loading ? <p className="text-[13px] text-[var(--sf-text-3)]">Loading agents…</p> : null}

        {noAgents ? (
          <div
            className="flex flex-col items-center gap-2 rounded-lg border border-[var(--sf-hairline)] px-6 py-10 text-center"
            data-testid="agents-empty"
          >
            <h3 className="text-[15px] font-semibold leading-normal text-[var(--sf-text-1)]">No agents yet</h3>
            <p className="max-w-[520px] text-[13px] leading-[1.5] text-[var(--sf-text-2)]">
              Create one to keep a revisioned instruction file in the project.
            </p>
          </div>
        ) : null}

        {!loading && !error && !noAgents ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                {FILTERS.map((chip) => (
                  <FilterChip
                    key={chip.id}
                    id={chip.id}
                    active={filter === chip.id}
                    label={chip.label}
                    count={counts[chip.id]}
                    onClick={() => setFilter(chip.id)}
                  />
                ))}
              </div>
              <label className="flex h-8 w-[260px] items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3">
                <LuSearch aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" />
                <input
                  type="search"
                  value={search}
                  aria-label="Search agents"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name, tool or model"
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
                />
              </label>
            </div>

            <div className="overflow-x-auto rounded-lg border border-[var(--sf-hairline)]" data-testid="agents-directory-table">
              <div className={`${GRID} h-9 border-b border-b-[var(--sf-hairline)]`}>
                {["Agent", "Model", "Reach", "Tools and approvals", "Status", "Last 7 days", "Activity"].map((label) => (
                  <span key={label} className="text-[11px] leading-normal text-[var(--sf-text-3)]">
                    {label}
                  </span>
                ))}
                <span aria-hidden />
              </div>
              <div className="[&>*+*]:border-t [&>*+*]:border-t-[var(--sf-hairline)]">
                {rows.map((row, index) => (
                  <DirectoryRowView
                    key={row.id}
                    row={row}
                    highlighted={index === cursor}
                    onFocusRow={() => setCursor(index)}
                    onShowAccess={() => setAccessFor(row.id)}
                    rowRef={(node) => {
                      rowRefs.current[index] = node;
                    }}
                  />
                ))}
              </div>
              {rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-[var(--sf-text-3)]">No agents match this filter.</p>
              ) : null}
            </div>

            <p className="text-xs leading-[1.33333] text-[var(--sf-text-2)]" data-testid="agents-totals">
              {totals.sessions} session{totals.sessions === 1 ? "" : "s"} · {totals.cost} total cost, all agents, all time
            </p>
            {hint ? <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{hint}</p> : null}
          </>
        ) : null}
      </div>

      {accessFor && rows.find((r) => r.id === accessFor) ? <AccessDialog row={rows.find((r) => r.id === accessFor)!} onClose={() => setAccessFor(null)} /> : null}
      <PageFooter left={!loading ? directoryFooterText(agents) : ""} right="↑ ↓ to move · ↵ to open" />
    </div>
  );
}
