import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LuCheck, LuMinus, LuPlug, LuPlus, LuRefreshCw, LuTriangleAlert, LuWrench } from "react-icons/lu";
import {
  checkChannelConnection, fetchChannelConnections, fetchConnections, fetchProjectMcp,
  type ChannelConnectionListing, type ChannelProviderMeta, type ConnectionListing, type ProjectMcpCatalogList,
} from "../../api";
import { ageLabel } from "../../pages/channelStatus";
import { connectionPath, navigate } from "../../routes";
import { AddConnectionDialog } from "./AddConnectionDialog";
import { errorReason, useChannelMeta } from "./channelMeta";
import { providerIcon } from "./providerIcons";
import {
  availableProviders, channelRows, connectionTotals, footerText, toolCards,
  type ConnectionRow,
} from "./connectionsModel";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const NOWRAP = "[white-space-collapse:collapse] [text-wrap-mode:nowrap]";
const EYEBROW = `text-[#8b8f98] font-sans text-[11px] font-medium leading-normal tracking-[0.88px] uppercase ${NOWRAP}`;
const TILE = "flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21]";
const GRID = "grid grid-cols-[minmax(0,1fr)_240px_132px_112px] items-center gap-4";

function ProviderIcon({ icon, size = "size-4" }: { icon: string; size?: string }) {
  const Icon = providerIcon(icon);
  return <Icon className={`${size} block text-[#a7aab2]`} aria-hidden />;
}

function ViaTag({ via }: { via: string }) {
  return (
    <span className={`rounded-[4px] border border-[#ffffff1a] bg-[#1a1c21] px-1.5 text-[11px] leading-[18px] text-[#a7aab2] ${NOWRAP}`}>
      via {via}
    </span>
  );
}

function SectionHead({ title, subtitle, aside }: { title: string; subtitle: string; aside?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-[15px] font-semibold leading-normal text-[#ecedee]">{title}</h2>
        <p className="text-[13px] leading-normal text-[#a7aab2]">{subtitle}</p>
      </div>
      {aside ? <span className={`shrink-0 text-xs leading-normal text-[#8b8f98] ${MONO}`}>{aside}</span> : null}
    </div>
  );
}

function StatusCell({ row }: { row: ConnectionRow }) {
  const { status } = row;
  const color = status.tone === "ok" ? "text-[#4cc38a]" : status.tone === "needs" ? "text-[#f5b544]" : "text-[#8b8f98]";
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className={`mt-[3px] shrink-0 ${color}`}>
        {status.tone === "ok" ? <LuCheck className="size-3.5 block" aria-hidden /> : status.tone === "needs" ? <LuTriangleAlert className="size-3.5 block" aria-hidden /> : <LuMinus className="size-3.5 block" aria-hidden />}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className={`text-[13px] leading-normal ${status.tone === "muted" ? "text-[#a7aab2]" : "text-[#ecedee]"}`}>{status.label}</span>
        {status.detail ? <span className="text-xs leading-[1.4] text-[#8b8f98]">{status.detail}</span> : null}
      </div>
    </div>
  );
}

function ChannelRow({ row, checking, onCheck, now }: { row: ConnectionRow; checking: boolean; onCheck: (id: string) => void; now: number }) {
  return (
    <div
      className={`${GRID} border-t border-t-[#ffffff12] px-4 py-3 ${row.kind === "channel" ? "cursor-pointer hover:bg-[#16171b]" : ""}`}
      {...(row.kind === "channel" ? { role: "link", tabIndex: 0, "aria-label": `Open ${row.name} ${row.id}`, onClick: () => navigate(connectionPath(row.id)), onKeyDown: (event: { key: string }) => { if (event.key === "Enter") navigate(connectionPath(row.id)); } } : {})}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className={TILE}><ProviderIcon icon={row.icon} /></div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium leading-normal text-[#ecedee]">{row.name}</span>
            {row.via ? <ViaTag via={row.via} /> : null}
          </div>
          <span className={`truncate text-xs leading-normal text-[#8b8f98] ${MONO}`} title={row.secondary}>{row.secondary}</span>
        </div>
      </div>
      <StatusCell row={row} />
      <span className={`text-xs leading-normal text-[#a7aab2] ${MONO}`}>
        {row.checkedAt ? ageLabel(row.checkedAt, now) : "—"}
      </span>
      <div className="flex justify-end">
        {row.checkable ? (
          <button
            type="button"
            disabled={checking}
            onClick={(event) => { event.stopPropagation(); onCheck(row.id); }}
            className="flex h-7 items-center gap-1.5 rounded-md border border-[#ffffff1a] bg-transparent px-2 text-xs text-[#a7aab2] hover:bg-[#1a1c21] disabled:opacity-60"
          >
            <LuRefreshCw className={`size-3 block ${checking ? "animate-spin" : ""}`} aria-hidden />
            {checking ? "Checking" : "Check now"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ChannelTableBlock({ rows, checking, onCheck, now }: { rows: ConnectionRow[]; checking: ReadonlySet<string>; onCheck: (id: string) => void; now: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#ffffff12] bg-[#131418]">
      <div className={`${GRID} px-4 py-2.5`}>
        <span className={EYEBROW}>Connection</span>
        <span className={EYEBROW}>Status</span>
        <span className={EYEBROW}>Last checked</span>
        <span />
      </div>
      {rows.map((row) => (
        <ChannelRow key={row.key} row={row} checking={checking.has(row.id)} onCheck={onCheck} now={now} />
      ))}
    </div>
  );
}

function AvailableTile({ provider, onConnect }: { provider: ChannelProviderMeta; onConnect: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-dashed border-[#ffffff1a] px-4 py-3">
      <div className={TILE}><ProviderIcon icon={provider.icon} /></div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium leading-normal text-[#ecedee]">{provider.label}</span>
        <span className="truncate text-xs leading-normal text-[#8b8f98]">{provider.blurb}</span>
      </div>
      <button type="button" onClick={onConnect} className="flex h-7 shrink-0 items-center rounded-md border border-[#ffffff1a] bg-transparent px-2.5 text-xs font-medium text-[#ecedee] hover:bg-[#1a1c21]">
        Connect
      </button>
    </div>
  );
}

function ToolCardView({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-[#ffffff12] bg-[#131418] p-4">
      <div className="flex items-center justify-between">
        <div className={TILE}><LuWrench className="size-4 block text-[#a7aab2]" aria-hidden /></div>
        <span className="flex items-center gap-1.5 text-xs text-[#8b8f98]">
          <LuMinus className="size-3 block" aria-hidden />
          Configured
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={`truncate text-[13px] font-medium leading-normal text-[#ecedee] ${MONO}`}>{name}</span>
        <span className="truncate text-xs leading-normal text-[#8b8f98]">{detail}</span>
      </div>
    </div>
  );
}

export function ConnectionsRedesign() {
  const [channels, setChannels] = useState<ChannelConnectionListing[]>([]);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [email, setEmail] = useState<ConnectionListing[]>([]);
  const [tools, setTools] = useState<ProjectMcpCatalogList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([fetchChannelConnections(), fetchConnections(), fetchProjectMcp()]).then(([channelResult, emailResult, toolResult]) => {
      if (cancelled) return;
      if (channelResult.status === "fulfilled") {
        setChannels(channelResult.value.connections);
        setChannelError(channelResult.value.error ?? null);
      } else {
        setChannelError(channelResult.reason instanceof Error ? channelResult.reason.message : String(channelResult.reason));
      }
      if (emailResult.status === "fulfilled") setEmail(emailResult.value);
      if (toolResult.status === "fulfilled") setTools(toolResult.value);
      setLoaded(true);
    });
    const tick = window.setInterval(() => setNow(Date.now()), 30000);
    return () => { cancelled = true; window.clearInterval(tick); };
  }, []);

  const onCheck = useCallback((id: string) => {
    setChecking((current) => new Set(current).add(id));
    void checkChannelConnection(id)
      .then((health) => { setChannels((current) => current.map((entry) => (entry.id === id ? { ...entry, health } : entry))); setNow(Date.now()); })
      .catch((error: unknown) => setChannelError(error instanceof Error ? error.message : String(error)))
      .finally(() => setChecking((current) => { const next = new Set(current); next.delete(id); return next; }));
  }, []);

  const { meta } = useChannelMeta();
  const rows = channelRows(channels, email, meta);
  const available = availableProviders(rows, meta);
  const cards = toolCards(tools?.status === "ok" ? tools.servers : []);
  const totals = connectionTotals(rows, cards);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0c0d0f]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <header className="flex w-full shrink-0 items-start justify-between gap-4 border-b border-b-[#ffffff12] px-7 pb-5 pt-5">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs leading-normal text-[#8b8f98]">Connections</span>
            <h1 className="text-2xl font-semibold leading-normal tracking-[-0.48px] text-[#ecedee]">Connections</h1>
            <p className="text-[13px] leading-normal text-[#a7aab2]">
              Connect an account once, then let stages send through it. Channels carry messages from a stage; tools let an agent reach other services.
            </p>
          </div>
          <button type="button" onClick={() => setDialog(meta?.providers[0]?.id ?? "")} className="flex h-8 shrink-0 items-center rounded-lg bg-[#ecedee] px-3 py-0 gap-2">
            <LuPlus className="size-3.5 block text-[#0c0d0f]" aria-hidden />
            <span className={`font-sans text-[13px] font-medium leading-normal text-[#0c0d0f] ${NOWRAP}`}>Add connection</span>
          </button>
        </header>

        <div className="flex flex-col gap-10 px-7 py-7">
          <section className="flex flex-col gap-4" aria-label="Communication channels">
            <SectionHead
              title="Communication channels"
              subtitle="Where a stage can send messages. Send-only: nothing is received yet."
              aside={loaded && rows.length > 0 ? `${totals.connectedChannels} of ${rows.length} connected` : undefined}
            />
            {channelError ? (
              <div className="flex items-start gap-2 rounded-lg border border-[#f5b54447] bg-[#16140f] px-3 py-2.5 text-[13px] text-[#f5b544]" role="alert">
                <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Could not load channels: {errorReason(meta, channelError)}
              </div>
            ) : null}
            {!loaded ? <div className="text-[13px] text-[#8b8f98]">Loading connections…</div> : null}
            {loaded && rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-[#ffffff12] bg-[#131418] px-6 py-8 text-center" data-testid="connections-empty">
                <div className={TILE}><LuPlug className="size-4 block text-[#a7aab2]" aria-hidden /></div>
                <h3 className="text-[15px] font-semibold leading-normal text-[#ecedee]">You haven&apos;t connected anything yet</h3>
                <p className="max-w-[520px] text-[13px] leading-[1.5] text-[#a7aab2]">
                  Connect a channel and your stages can send messages through it, for example a Slack post when a run finishes. Pick a provider below to see how to set it up.
                </p>
              </div>
            ) : null}
            {loaded && rows.length > 0 ? <ChannelTableBlock rows={rows} checking={checking} onCheck={onCheck} now={now} /> : null}
            {loaded && available.length > 0 ? (
              <div className="flex flex-col gap-3">
                {rows.length > 0 ? <span className={EYEBROW}>Available to connect</span> : null}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {available.map((provider) => (
                    <AvailableTile key={provider.id} provider={provider} onConnect={() => setDialog(provider.id)} />
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-4" aria-label="Tools">
            <SectionHead
              title="Tools"
              subtitle="MCP servers agents call during a run. Not a way to talk to them."
              aside={loaded ? `${cards.length} configured` : undefined}
            />
            {tools?.status === "invalid_config" ? (
              <div className="rounded-lg border border-[#f5b54447] bg-[#16140f] px-3 py-2.5 text-[13px] text-[#f5b544]" role="alert">.mcp.json could not be read.</div>
            ) : null}
            {cards.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {cards.map((card) => <ToolCardView key={card.name} {...card} />)}
              </div>
            ) : null}
            {loaded ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#ffffff1a] px-4 py-3 text-[13px] text-[#8b8f98]">
                <LuPlus className="size-3.5 block" aria-hidden />
                Add tools by listing MCP servers in <span className={MONO}>.mcp.json</span> beside <span className={MONO}>stageflow.yaml</span>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      <footer className="flex h-10 shrink-0 items-center justify-between border-t border-t-[#ffffff12] px-7">
        <span className={`text-xs leading-normal text-[#8b8f98] ${MONO}`}>{loaded ? footerText(totals) : ""}</span>
        <span className="text-xs leading-normal text-[#8b8f98]">Changes apply immediately. connections.yaml never holds a secret.</span>
      </footer>

      {dialog ? (
        <AddConnectionDialog
          initial={dialog}
          existing={channels}
          onClose={() => setDialog(null)}
          onSaved={(id) => { setDialog(null); navigate(connectionPath(id)); }}
        />
      ) : null}
    </div>
  );
}
