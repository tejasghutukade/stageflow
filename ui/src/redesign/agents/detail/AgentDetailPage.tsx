import { useCallback, useEffect, useState } from "react";
import { LuCopy, LuGlobe, LuTriangleAlert } from "react-icons/lu";
import {
  AgentApiError,
  agentsApi,
  type AgentDetail,
  type AgentSessionListItem,
  type SessionStats,
  type SessionStatus,
} from "../../../api/agents";
import { agentPath, agentSessionPath, agentsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { AgentLoadError } from "../AgentLoadState";
import { MONO, PAGE_BG } from "../agentsTokens";
import { AgentDefinitionForm } from "../config/AgentDefinitionForm";
import { modelLabel, webChatLink, webChatState, type WebChatState } from "../model/definition";
import { formatCost, formatTokens, relativeTime, sessionSubtitle, sourceLabel } from "../model/format";
import { useAgentDetail, useEditorOptions } from "../model/hooks";
import { sessionStatusView } from "../model/sessionStatus";
import { consumeAgentCreated } from "../useAgent";
import { Button, KeyValue, PageFooter, PageHeader, SelectField, Tabs } from "../ui";

const SESSION_GRID = "grid grid-cols-[minmax(0,1fr)_96px_130px_50px_70px_70px_96px] items-center gap-4 px-7 min-w-[880px]";
const PAGE_SIZE = 25;

type DetailTab = "sessions" | "configuration";

function AvailabilityStatus({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="flex items-center gap-1.5 text-xs leading-normal text-[var(--sf-ok)]">
      <span aria-hidden>✓</span>
      <span>Enabled</span>
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-xs leading-normal text-[var(--sf-text-2)]">
      <span aria-hidden>○</span>
      <span>Disabled</span>
    </span>
  );
}

const WEB_CHAT_STATE: Record<WebChatState, { label: string; color: string; note: string }> = {
  live: { label: "Live", color: "text-[var(--sf-ok)]", note: "Share this link with customers. Visitors are anonymous and can only chat." },
  waiting: { label: "Waiting for you to enable the agent", color: "text-[var(--sf-needs)]", note: "The page opens as soon as you enable this agent." },
  off: { label: "Off", color: "text-[var(--sf-text-2)]", note: "There is no chat page for this agent. Turn web chat on in Edit agent." },
};

function WebChatCard({ detail }: { detail: AgentDetail }) {
  const { agent, definition } = detail;
  const state = webChatState(agent.enabled, definition);
  const link = state === "off" ? null : webChatLink(agent);
  const copy = () =>
    void navigator.clipboard?.writeText(link!).then(
      () => showToast("Link copied"),
      () => showToast("Could not copy the link"),
    );
  return (
    <section className="flex flex-col gap-3" aria-label="Web chat">
      <h2 className="flex items-center gap-2 text-base font-semibold leading-normal text-[var(--sf-text-1)]">
        <LuGlobe aria-hidden className="size-4 text-[var(--sf-text-2)]" />
        Web chat
      </h2>
      <span className={`flex items-center gap-1.5 text-xs leading-normal ${WEB_CHAT_STATE[state].color}`}>
        <span aria-hidden>{state === "live" ? "●" : "○"}</span>
        <span>{WEB_CHAT_STATE[state].label}</span>
      </span>
      {state !== "off" ? (
        link ? (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-3">
            <span className={`${MONO} break-all text-xs leading-[1.5] text-[var(--sf-text-1)]`}>{link}</span>
            <button
              type="button"
              onClick={copy}
              className="flex w-fit items-center gap-1.5 text-xs leading-normal text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
            >
              <LuCopy aria-hidden className="size-3" />
              Copy link
            </button>
          </div>
        ) : (
          <p className="text-xs leading-normal text-[var(--sf-text-3)]">The link appears once this agent is saved with web chat on.</p>
        )
      ) : null}
      <p className="text-[13px] leading-[1.6] text-[var(--sf-text-2)]">{WEB_CHAT_STATE[state].note}</p>
    </section>
  );
}

function SummaryAside({ detail }: { detail: AgentDetail }) {
  const { agent, definition } = detail;
  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-7 border-l border-l-[var(--sf-hairline)] p-6">
      <WebChatCard detail={detail} />
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold leading-normal text-[var(--sf-text-1)]">Configuration</h2>
        <div className="flex flex-col gap-4">
          <KeyValue label="Version" value={`v${agent.revision}`} />
          <KeyValue label="Model" value={<span className={MONO}>{modelLabel(definition?.model ?? null)}</span>} />
          <KeyValue label="Max turns" value={definition ? String(definition.limits.max_turns) : "—"} />
          <KeyValue label="Time per session" value={definition ? `${definition.limits.session_minutes} minutes` : "—"} />
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold leading-normal text-[var(--sf-text-1)]">Availability</h2>
        <AvailabilityStatus enabled={agent.enabled} />
        <p className="text-[13px] leading-[1.6] text-[var(--sf-text-2)]">
          {agent.enabled
            ? "New sessions start on the current version. Disabling refuses new work and keeps history."
            : "New work is not accepted while this agent is disabled."}
        </p>
      </section>
      <details className="group text-xs leading-normal text-[var(--sf-text-3)]">
        <summary className="cursor-pointer list-none text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)] [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="mr-1.5 inline-block transition-transform group-open:rotate-90">›</span>
          Internal access
        </summary>
        <p className="mt-2 leading-[1.6]">
          Console, CLI and MCP{definition?.channel ? ` · ${definition.channel.connection_id}` : ""}
        </p>
        {definition?.schedule ? <p className={`${MONO} mt-1`}>Schedule {definition.schedule.cron}</p> : null}
      </details>
    </aside>
  );
}

function EmptySessions({ detail, onReview }: { detail: AgentDetail; onReview: () => void }) {
  const enabled = detail.agent.enabled;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-[var(--sf-panel)] text-2xl text-[var(--sf-text-2)]">○</div>
        <h2 className="text-xl font-semibold leading-normal text-[var(--sf-text-1)]">No sessions yet</h2>
        <p className="text-[13px] leading-normal text-[var(--sf-text-2)]">
          {enabled ? "Sessions appear here when someone messages this agent." : "Enable this agent when you are ready to receive work."}
        </p>
        <p className="text-xs leading-normal text-[var(--sf-text-3)]">
          {enabled ? `Try it from the CLI: sf agents chat ${detail.agent.id} --message "Hello"` : "Enabling does not start a run."}
        </p>
        <Button onClick={onReview}>Review configuration</Button>
      </div>
      <SummaryAside detail={detail} />
    </div>
  );
}

function Metrics({ stats }: { stats: SessionStats }) {
  const rate = stats.turnsFinished7d > 0 ? `${Math.round((stats.turnsSucceeded7d / stats.turnsFinished7d) * 100)}%` : "—";
  return (
    <div className="grid grid-cols-2 gap-6 border-b border-b-[var(--sf-hairline)] px-7 py-5 md:grid-cols-4">
      {[
        { label: "Active runs", value: String(stats.active) },
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

function SessionsList({ agentId, stats: initialStats }: { agentId: string; stats: SessionStats }) {
  const [status, setStatus] = useState<SessionStatus | "">("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<AgentSessionListItem[] | null>(null);
  const [stats, setStats] = useState(initialStats);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (after?: string) => {
      try {
        const page = await agentsApi.sessions(agentId, {
          limit: PAGE_SIZE,
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
    [agentId, status, source, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Metrics stats={stats} />
      <div className="flex flex-wrap items-center justify-between gap-3 px-7 py-4">
        <div className="flex gap-2">
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
              options={[
                { value: "", label: "All sources" },
                ...["web", "console", "cli", "mcp", "schedule", "slack", "email", "telegram", "photon", "imessage", "agentmail"].map((value) => ({
                  value,
                  label: sourceLabel(value),
                })),
              ]}
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
      <div className="overflow-x-auto">
        <div className={`${SESSION_GRID} h-10`}>
          {["Session", "Source", "Latest run", "Runs", "Tokens", "Est. cost", "Updated"].map((label) => (
            <span key={label} className="text-[11px] uppercase leading-normal tracking-[0.7px] text-[var(--sf-text-3)]">
              {label}
            </span>
          ))}
        </div>
        {rows === null ? (
          <p className="border-t border-t-[var(--sf-hairline)] px-7 py-6 text-xs text-[var(--sf-text-3)]">Loading sessions…</p>
        ) : rows.length === 0 ? (
          <p className="border-t border-t-[var(--sf-hairline)] px-7 py-6 text-xs text-[var(--sf-text-3)]">No sessions match these filters.</p>
        ) : (
          rows.map((row) => {
            const state = sessionStatusView(row);
            const open = () => navigate(agentSessionPath(agentId, row.id));
            return (
              <div
                key={row.id}
                role="link"
                tabIndex={0}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.key === "Enter") open();
                }}
                className={`${SESSION_GRID} min-h-[72px] cursor-pointer border-t border-t-[var(--sf-hairline)] outline-none hover:bg-[var(--sf-panel)] focus-visible:bg-[var(--sf-panel)]`}
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="truncate text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">{row.title ?? "New session"}</span>
                  <span className="truncate text-xs leading-normal text-[var(--sf-text-3)]">
                    {sessionSubtitle(row)}
                  </span>
                </div>
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
      </div>
      {cursor ? (
        <div className="flex justify-center border-t border-t-[var(--sf-hairline)] py-4">
          <Button onClick={() => void load(cursor)}>Load more</Button>
        </div>
      ) : null}
    </div>
  );
}

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const { detail, loading, error, setDetail } = useAgentDetail(agentId);
  const [tab, setTab] = useState<DetailTab>("sessions");
  const [justCreated] = useState(() => consumeAgentCreated(agentId));
  const [busy, setBusy] = useState(false);
  const options = useEditorOptions();

  if (!detail) return <AgentLoadError loading={loading} error={error} />;
  if (!detail.definition) return <AgentLoadError loading={false} error={null} invalid={detail} />;
  const { agent } = detail;

  async function onToggle() {
    if (busy) return;
    setBusy(true);
    try {
      const next = await agentsApi.setEnabled(agent.id, !agent.enabled);
      setDetail(next);
      showToast(next.agent.enabled ? "Enabled" : "Disabled");
    } catch (err) {
      showToast(err instanceof AgentApiError ? err.message : "Could not change the agent");
    } finally {
      setBusy(false);
    }
  }

  const hasSessions = agent.stats.total > 0;

  return (
    <div className={PAGE_BG}>
      <PageHeader
        roomy
        crumbs={[{ label: "Agents", onClick: () => navigate(agentsPath()) }, { label: agent.name }]}
        title={agent.name}
        description={agent.description ?? undefined}
        actions={
          <>
            <AvailabilityStatus enabled={agent.enabled} />
            {agent.enabled ? (
              <>
                <Button disabled={busy} onClick={() => void onToggle()}>
                  Disable agent
                </Button>
                <Button onClick={() => navigate(agentPath(agent.id, "edit"))}>Edit agent</Button>
                <Button variant="primary" onClick={() => navigate(agentSessionPath(agent.id, "new"))}>
                  New session
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => navigate(agentPath(agent.id, "edit"))}>Edit agent</Button>
                <Button variant="primary" disabled={busy || agent.issues.length > 0} onClick={() => void onToggle()}>
                  Enable agent
                </Button>
              </>
            )}
          </>
        }
      />
      <Tabs<DetailTab>
        tabs={[
          { id: "sessions", label: "Sessions" },
          { id: "configuration", label: "Configuration" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {agent.issues.length > 0 ? (
        <div className="flex shrink-0 items-start gap-3 border-b border-b-[var(--sf-hairline)] bg-[#f5b5440a] px-7 py-3 text-xs leading-[1.5]" role="alert">
          <LuTriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--sf-needs)]" />
          <span className="text-[var(--sf-text-1)]">
            The YAML file was edited and is now invalid, so v{agent.revision} stays in use.{" "}
            <span className="text-[var(--sf-text-2)]">{agent.issues.map((issue) => `${issue.path || "file"}: ${issue.message}`).join(" · ")}</span>
          </span>
        </div>
      ) : null}
      {justCreated && tab === "sessions" ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-b-[var(--sf-hairline)] px-7 py-4 text-[13px] leading-normal">
          <span className="text-[var(--sf-ok)]">✓</span>
          <span className="text-[var(--sf-text-1)]">Agent created. It is {agent.enabled ? "enabled" : "disabled"} and has not run yet.</span>
        </div>
      ) : null}

      {tab === "sessions" ? (
        hasSessions ? (
          <SessionsList agentId={agent.id} stats={agent.stats} />
        ) : (
          <EmptySessions detail={detail} onReview={() => setTab("configuration")} />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentDefinitionForm
            mode="view"
            definition={detail.definition}
            issues={[]}
            warnings={detail.warnings}
            options={options}
            revision={agent.revision}
            webChatUrl={webChatLink(agent)}
            onOpenAgent={(id) => navigate(agentPath(id))}
          />
        </div>
      )}

      <PageFooter
        left={`${justCreated ? "Created just now · " : ""}Configuration v${agent.revision}`}
        right={`${agent.stats.total} session${agent.stats.total === 1 ? "" : "s"}${agent.stats.lastActivityAt ? ` · last activity ${relativeTime(agent.stats.lastActivityAt).toLowerCase()}` : ""}`}
      />
    </div>
  );
}
