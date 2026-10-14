import { useEffect, useState } from "react";
import {
  checkChannelConnection, fetchChannelConnections, fetchConnections, fetchProjectMcp,
  type ChannelConnectionListing, type ConnectionListing, type ProjectMcpCatalogList,
} from "../api";
import { ageLabel, channelStatus, codeMessage, PROVIDER_LABELS } from "./channelStatus";

export function ConnectionTable({ connections }: { connections: ConnectionListing[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Channel</th>
          <th>Address</th>
          <th>Status</th>
          <th>Folders</th>
        </tr>
      </thead>
      <tbody>
        {connections.map((connection) => (
          <tr key={`${connection.channel}:${connection.id}`}>
            <td>
              {connection.displayName}
              <div className="mono muted" style={{ fontSize: "var(--font-size-xs)" }}>
                {connection.id}
              </div>
            </td>
            <td>{connection.channel}</td>
            <td>{connection.address}</td>
            <td className={connection.enabled ? undefined : "muted"}>
              {connection.enabled ? "Enabled" : "Disabled"}
            </td>
            <td>{connection.folders.join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChannelTable({
  connections, checking, onCheck, now,
}: {
  connections: ChannelConnectionListing[];
  checking?: ReadonlySet<string>;
  onCheck?: (id: string) => void;
  now?: number;
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Connection</th>
          <th>Provider</th>
          <th>Identity</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {connections.map((connection) => {
          const status = channelStatus(connection);
          return (
            <tr key={connection.id}>
              <td>
                {connection.displayName}
                <div className="mono muted" style={{ fontSize: "var(--font-size-xs)" }}>{connection.id}</div>
              </td>
              <td>{PROVIDER_LABELS[connection.provider] ?? connection.provider}</td>
              <td>{connection.identity ?? ""}</td>
              <td
                className={status.tone === "muted" ? "muted" : undefined}
                style={status.tone === "fail" ? { color: "var(--color-text-red)" } : undefined}
              >
                {status.label}
                {status.detail ? <div style={{ fontSize: "var(--font-size-xs)" }}>{status.detail}</div> : null}
                {connection.health ? (
                  <div className="muted" style={{ fontSize: "var(--font-size-xs)" }}>
                    Checked {ageLabel(connection.health.checkedAt, now)}
                  </div>
                ) : null}
              </td>
              <td>
                {connection.enabled && onCheck ? (
                  <button type="button" disabled={checking?.has(connection.id)} onClick={() => onCheck(connection.id)}>
                    {checking?.has(connection.id) ? "Checking…" : "Check now"}
                  </button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ToolTable({ servers }: { servers: ProjectMcpCatalogList["servers"] }) {
  return (
    <table className="table">
      <thead>
        <tr><th>Tool server</th><th>Transport</th></tr>
      </thead>
      <tbody>
        {servers.map((server) => (
          <tr key={server.name}>
            <td className="mono">{server.name}</td>
            <td>{server.transport}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelConnectionListing[]>([]);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [tools, setTools] = useState<ProjectMcpCatalogList | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void fetchChannelConnections().then(
      (result) => {
        if (cancelled) return;
        setChannels(result.connections);
        setChannelError(result.error ?? null);
      },
      (err: unknown) => { if (!cancelled) setChannelError(err instanceof Error ? err.message : String(err)); },
    );
    void fetchProjectMcp().then(
      (result) => { if (!cancelled) setTools(result); },
      () => { if (!cancelled) setTools(null); },
    );
    return () => { cancelled = true; };
  }, []);

  const onCheck = (id: string) => {
    setChecking((current) => new Set(current).add(id));
    void checkChannelConnection(id)
      .then((health) => setChannels((current) => current.map((c) => (c.id === id ? { ...c, health } : c))))
      .catch((err: unknown) => setChannelError(err instanceof Error ? err.message : String(err)))
      .finally(() => setChecking((current) => { const next = new Set(current); next.delete(id); return next; }));
  };

  useEffect(() => {
    let cancelled = false;
    void fetchConnections().then(
      (result) => { if (!cancelled) setConnections(result); },
      (err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <p>Communication channels and tools available to your stages and triggers.</p>
        </div>
      </div>
      <p className="muted">
        This view is read-only. Channels are defined in connections.yaml and email accounts in
        email.yaml, both beside stageflow.yaml. Restart Stageflow to load changes. Secrets are
        never shown.
      </p>
      <h2>Communication channels</h2>
      {channelError ? (
        <p style={{ color: "var(--color-text-red)" }}>
          Could not load channels: {codeMessage(channelError)}
        </p>
      ) : null}
      {!channelError && channels.length === 0 ? (
        <div className="empty-hint">
          No channels configured. Copy connections.example.yaml to connections.yaml to send from stages.
        </div>
      ) : null}
      {channels.length > 0 ? <ChannelTable connections={channels} checking={checking} onCheck={onCheck} /> : null}
      <h2>Email accounts</h2>
      {error ? <p style={{ color: "var(--color-text-red)" }}>Could not load connections: {error}</p> : null}
      {loading ? <p className="muted">Loading connections…</p> : null}
      {!loading && !error && connections.length === 0 ? (
        <div className="empty-hint">No email accounts configured. Add an account to email.yaml to get started.</div>
      ) : null}
      {!loading && !error && connections.length > 0 ? <ConnectionTable connections={connections} /> : null}
      <p className="muted">Enabled means the account is available for use, not that its connection has been tested.</p>
      <h2>Tools</h2>
      {tools?.status === "ok" && tools.servers.length > 0 ? <ToolTable servers={tools.servers} /> : null}
      {tools?.status === "invalid_config" ? <p className="muted">.mcp.json could not be read.</p> : null}
      {!tools || tools.status === "missing_catalog" || (tools.status === "ok" && tools.servers.length === 0) ? (
        <div className="empty-hint">No tool servers. Add MCP servers to .mcp.json beside stageflow.yaml.</div>
      ) : null}
    </div>
  );
}
