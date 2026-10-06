import { useEffect, useState } from "react";
import { fetchConnections, type ConnectionListing } from "../api";

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

export function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          <p>Communication accounts available to your stages and triggers. Email is supported today.</p>
        </div>
      </div>
      <p className="muted">
        This view is read-only. Manage email accounts in email.yaml beside stageflow.yaml,
        then restart Stageflow to load changes. Credentials are not shown.
      </p>
      {error ? <p style={{ color: "var(--color-text-red)" }}>Could not load connections: {error}</p> : null}
      {loading ? <p className="muted">Loading connections…</p> : null}
      {!loading && !error && connections.length === 0 ? (
        <div className="empty-hint">No email accounts configured. Add an account to email.yaml to get started.</div>
      ) : null}
      {!loading && !error && connections.length > 0 ? <ConnectionTable connections={connections} /> : null}
      <p className="muted">Enabled means the account is available for use, not that its connection has been tested.</p>
    </div>
  );
}
