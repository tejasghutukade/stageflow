import { useCallback, useEffect, useMemo, useState } from "react";
import { LuGlobe, LuTriangleAlert } from "react-icons/lu";
import { agentsApi, type AgentSessionListItem, type AgentSummary, type SessionStats, type SessionStatus } from "../../../api/agents";
import { agentSessionPath, navigate } from "../../../routes";
import { MONO, PAGE_BG } from "../agentsTokens";
import { formatCost, formatTokens, relativeTime, sessionSubtitle, sourceLabel } from "../model/format";
import { sessionStatusView } from "../model/sessionStatus";
import { Button, PageFooter, SelectField } from "../ui"
import { PageHeader } from "../../shell/PageHeader";;

const GRID = "grid grid-cols-[minmax(0,1fr)_150px_96px_130px_50px_70px_70px_96px] items-center gap-4 px-7 min-w-[1040px]";
const PAGE_SIZE = 25;
const POLL_MS = 5000;
const SOURCES = ["web", "console", "cli", "mcp", "schedule", "slack", "email", "telegram", "photon", "imessage", "agentmail"];

function Metrics({ stats }: { stats: SessionStats }) {
  const rate = stats.turnsFinished7d > 0 ? `${Math.round((stats.turnsSucceeded7d / stats.turnsFinished7d) * 100)}%` : "—";
  return (
    <div className="grid grid-cols-2 gap-6 border-b border-b-[var(--sf-hairline)] px-7 py-5 md:grid-cols-4">
      {[
        { label: "Active sessions", value: String(stats.active) },
        { label: "Sessions this week", value: String(stats.last7Days) },
        { label: "Run success rate", value: rate },
        { label: "Estimated cost", value: formatCost(stats.cost7d) },
      ].map((metric) => (
        <div key={metric.label} className="flex flex-col gap-2">
          <span className="text-xs leading-normal text-[var(--sf-text-3)]">{metric.label}</span>
          <span className={`${MONO} text-[22px] font-medium leading-normal text-[var(--sf-text-1)]`}>{metric.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Sessions of every agent in one list: what is running, what waits on you, what failed. */
export function AgentSessionsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState<SessionStatus | "">("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<AgentSessionListItem[] | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agentsApi.list().then(setAgents, () => setAgents([]));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const names = useMemo(() => new Map(agents.map((entry) => [entry.id, entry.name])), [agents]);

  const load = useCallback(
    async (after?: string) => {
      try {
        const page = await agentsApi.allSessions({
          limit: PAGE_SIZE,
          ...(agent ? { agent } : {}),
          ...(status ? { status } : {}),
          ...(source ? { source } : {}),
          ...(query ? { q: query } : {}),
          ...(after ? { cursor: after } : {}),
        });
        setRows((prev) => (after && prev ? [...prev, ...page.sessions] : page.sessions));
        setCursor(page.nextCursor);
        setStats(page.stats);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load sessions");
      }
    },
    [agent, status, source, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the first page fresh while something is live.
  const live = (stats?.active ?? 0) > 0;
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, load]);

  return (
    <div className={PAGE_BG}>
      <PageHeader
        crumbs={[{ label: "Activity" }, { label: "Agent sessions" }]}
        title="Agent sessions"
        description="Every conversation your agents are having or have had, across all channels."
      />
      {stats ? <Metrics stats={stats} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 px-7 py-4">
        <div className="flex flex-wrap gap-2">
          <div className="w-48">
            <SelectField
              value={agent}
              ariaLabel="Agent"
              onChange={setAgent}
              options={[{ value: "", label: "All agents" }, ...agents.map((entry) => ({ value: entry.id, label: entry.name }))]}
            />
          </div>
          <div className="w-40">
            <SelectField
              value={status}
              ariaLabel="Status"
              onChange={setStatus}
              options={[
                { value: "", label: "All statuses" },
                { value: "open", label: "Open" },
                { value: "running", label: "Running" },
                { value: "waiting", label: "Waiting on you" },
                { value: "held", label: "Held" },
              ]}
            />
          </div>
          <div className="w-40">
            <SelectField
              value={source}
              ariaLabel="Source"
              onChange={setSource}
              options={[{ value: "", label: "All sources" }, ...SOURCES.map((value) => ({ value, label: sourceLabel(value) }))]}
            />
          </div>
        </div>
        <input
          type="search"
          value={search}
          aria-label="Search sessions"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search sessions or messages…"
          className="h-8 w-[260px] rounded-lg border border-[var(--sf-hairline-strong)] bg-transparent px-3 text-xs leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
        />
      </div>
      {error ? (
        <p className="flex items-center gap-2 px-7 py-3 text-xs text-[var(--sf-fail)]">
          <LuTriangleAlert aria-hidden className="size-3" />
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={`${GRID} h-10`}>
          {["Session", "Agent", "Source", "Latest run", "Runs", "Tokens", "Est. cost", "Updated"].map((label) => (
            <span key={label} className="text-[11px] uppercase leading-normal tracking-[0.7px] text-[var(--sf-text-3)]">
              {label}
            </span>
          ))}
        </div>
        {rows === null ? (
          <p className="border-t border-t-[var(--sf-hairline)] px-7 py-6 text-xs text-[var(--sf-text-3)]">Loading sessions…</p>
        ) : rows.length === 0 ? (
          <p className="border-t border-t-[var(--sf-hairline)] px-7 py-6 text-xs text-[var(--sf-text-3)]">
            {agent || status || source || query ? "No sessions match these filters." : "No agent sessions yet. They appear when someone messages an agent."}
          </p>
        ) : (
          rows.map((row) => {
            const state = sessionStatusView(row);
            const open = () => navigate(agentSessionPath(row.agentId, row.id));
            return (
              <div
                key={row.id}
                role="link"
                tabIndex={0}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.key === "Enter") open();
                }}
                className={`${GRID} min-h-[72px] cursor-pointer border-t border-t-[var(--sf-hairline)] outline-none hover:bg-[var(--sf-panel)] focus-visible:bg-[var(--sf-panel)]`}
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="truncate text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">{row.title ?? "New session"}</span>
                  <span className="truncate text-xs leading-normal text-[var(--sf-text-3)]">{sessionSubtitle(row)}</span>
                </div>
                <span className="truncate text-xs leading-normal text-[var(--sf-text-2)]">{names.get(row.agentId) ?? row.agentId}</span>
                <span className="flex items-center gap-1.5 text-xs leading-normal text-[var(--sf-text-2)]">
                  {row.source === "web" ? <LuGlobe aria-hidden className="size-3 shrink-0" /> : null}
                  {sourceLabel(row.source)}
                </span>
                <span className={`flex items-center gap-1.5 text-xs leading-normal ${state.color}`}>
                  <span aria-hidden>{state.symbol}</span>
                  <span>{state.label}</span>
                </span>
                <span className={`${MONO} text-xs leading-normal text-[var(--sf-text-2)]`}>{row.turnCount}</span>
                <span className={`${MONO} text-xs leading-normal text-[var(--sf-text-2)]`}>{formatTokens(row.inputTokens + row.outputTokens)}</span>
                <span className={`${MONO} text-xs leading-normal text-[var(--sf-text-2)]`}>{formatCost(row.costUsd)}</span>
                <span className={`${MONO} text-xs leading-normal text-[var(--sf-text-2)]`}>{relativeTime(row.updatedAt)}</span>
              </div>
            );
          })
        )}
        {cursor ? (
          <div className="flex justify-center border-t border-t-[var(--sf-hairline)] py-4">
            <Button onClick={() => void load(cursor)}>Load more</Button>
          </div>
        ) : null}
      </div>
      <PageFooter left={stats ? `${stats.total} sessions · ${stats.active} active` : ""} />
    </div>
  );
}
