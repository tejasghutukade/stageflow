import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LuCheck, LuChevronRight, LuCircle, LuPlus, LuSearch, LuTriangleAlert } from "react-icons/lu";
import { agentsApi, type AgentSummary } from "../../api/agents";
import { agentPath, navigate } from "../../routes";
import {
  directoryFooterText,
  filterAgents,
  filterCounts,
  searchAgents,
  toDirectoryRow,
  type AgentDirectoryFilter,
  type AgentDirectoryRow,
} from "./agentsDirectoryModel";
import { MONO, NOWRAP, PAGE_BG } from "./agentsTokens";
import { Button, PageFooter, PageHeader } from "./ui";

const GRID =
  "grid grid-cols-[minmax(0,1fr)_170px_210px_120px_130px_120px_14px] items-center gap-4 px-4 min-w-[1000px]";

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
  return (
    <div className="flex items-center gap-1.5">
      {row.statusTone === "ok" ? (
        <LuCheck aria-hidden className="size-3 shrink-0 text-[var(--sf-ok)]" />
      ) : row.statusTone === "needs" ? (
        <LuTriangleAlert aria-hidden className="size-3 shrink-0 text-[var(--sf-needs)]" />
      ) : (
        <LuCircle aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" />
      )}
      <span
        className={`text-xs leading-[1.33333] ${
          row.statusTone === "ok"
            ? "text-[var(--sf-text-1)]"
            : row.statusTone === "needs"
              ? "text-[var(--sf-needs)]"
              : "text-[var(--sf-text-3)]"
        }`}
      >
        {row.statusLabel}
      </span>
    </div>
  );
}

function DirectoryRowView({
  row,
  highlighted,
  onOpen,
  rowRef,
}: {
  row: AgentDirectoryRow;
  highlighted: boolean;
  onOpen: () => void;
  rowRef: (node: HTMLDivElement | null) => void;
}) {
  const dim = !row.enabled && !row.needsSetup;
  return (
    <div
      ref={rowRef}
      role="link"
      tabIndex={0}
      aria-label={`Open ${row.name}`}
      className={`${GRID} cursor-pointer py-3 outline-none hover:bg-[var(--sf-panel)] focus-visible:bg-[var(--sf-panel)] ${
        highlighted ? "bg-[var(--sf-panel)]" : ""
      }`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
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
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs leading-[1.33333] text-[var(--sf-text-2)]">{row.toolsLine}</span>
        <span
          className={`text-[11px] leading-normal ${
            row.approvalsTone === "needs" ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-3)]"
          }`}
        >
          {row.approvalsLine}
        </span>
      </div>
      <StatusCell row={row} />
      <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)]`}>{row.last7Days}</span>
      <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{row.activityLabel}</span>
      <LuChevronRight aria-hidden className="size-3.5 text-[var(--sf-text-3)]" />
    </div>
  );
}

function directoryHint(agents: readonly AgentSummary[]): string | null {
  const parts: string[] = [];
  for (const agent of agents.filter((a) => a.issues.length > 0)) {
    parts.push(`${agent.name} can't be enabled until ${agent.issues[0]!.message}.`);
  }
  if (agents.some((agent) => !agent.enabled)) {
    parts.push("Disabled agents keep their history but can't start sessions.");
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function AgentsDirectoryPage({ onNewAgent }: { onNewAgent: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AgentDirectoryFilter>("all");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(-1);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

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

  const counts = useMemo(() => filterCounts(agents), [agents]);
  const rows = useMemo(() => {
    const filtered = filterAgents(agents, filter);
    const searched = searchAgents(filtered, search);
    return searched.map(toDirectoryRow);
  }, [agents, filter, search]);

  const noAgents = !loading && !error && counts.all === 0;
  const hint = directoryHint(agents);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next =
      event.key === "ArrowDown" ? Math.min(rows.length - 1, cursor + 1) : Math.max(0, cursor - 1);
    setCursor(next);
    rowRefs.current[next]?.focus();
  }

  return (
    <div className={PAGE_BG} onKeyDown={onKeyDown}>
      <PageHeader
        crumbs={[{ label: "Agents" }]}
        title="Agents"
        description="Agents defined in this project. Each one runs sealed, with only the tools and approvals you give it."
        actions={
          <Button variant="primary" icon={<LuPlus aria-hidden />} onClick={onNewAgent}>
            New agent
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-5">
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
                {["Agent", "Model", "Tools and approvals", "Status", "Last 7 days", "Activity"].map((label) => (
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
                    onOpen={() => navigate(agentPath(row.id))}
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

            {hint ? <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{hint}</p> : null}
          </>
        ) : null}
      </div>

      <PageFooter left={!loading ? directoryFooterText(agents) : ""} right="↑ ↓ to move · ↵ to open" />
    </div>
  );
}
