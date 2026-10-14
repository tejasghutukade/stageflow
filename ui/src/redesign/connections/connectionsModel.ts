import type {
  ChannelConnectionListing, ChannelMeta, ChannelProviderMeta, ConnectionListing, NewChannelConnection, ProjectMcpCatalogEntry,
} from "../../api";
import { channelStatus, type ChannelStatus } from "../../pages/channelStatus";
import { errorHint, errorReason, providerLabel, providerOf } from "./channelMeta";

export type ConnectionRow = {
  key: string;
  id: string;
  kind: "channel" | "email";
  /** Provider id for channels; "email" for IMAP/SMTP accounts. */
  provider: string;
  name: string;
  secondary: string;
  via?: string;
  /** Icon key from the host description; the console maps it. */
  icon: string;
  status: ChannelStatus;
  checkedAt?: string;
  checkable: boolean;
};

export function channelRows(
  channels: readonly ChannelConnectionListing[],
  emailAccounts: readonly ConnectionListing[],
  meta?: ChannelMeta | null,
): ConnectionRow[] {
  const rows: ConnectionRow[] = channels.map((connection) => {
    const described = providerOf(meta, connection.provider);
    const via = described?.via;
    return {
      key: `channel:${connection.id}`,
      id: connection.id,
      kind: "channel",
      provider: connection.provider,
      name: providerLabel(meta, connection.provider),
      secondary: connection.identity ? `${connection.identity} · ${connection.id}` : connection.id,
      ...(via ? { via } : {}),
      icon: described?.icon ?? "plug",
      status: channelStatus(connection, meta),
      ...(connection.health ? { checkedAt: connection.health.checkedAt } : {}),
      checkable: connection.enabled,
    };
  });
  for (const account of emailAccounts) {
    rows.push({
      key: `email:${account.id}`,
      id: account.id,
      kind: "email",
      provider: "email",
      name: account.displayName,
      secondary: `${account.address} · IMAP/SMTP`,
      icon: "mail",
      status: account.enabled ? { label: "Enabled", tone: "muted" } : { label: "Disabled", tone: "muted" },
      checkable: false,
    });
  }
  return rows;
}

/** Providers that have no connection yet, offered as dashed tiles. */
export function availableProviders(rows: readonly ConnectionRow[], meta: ChannelMeta | null | undefined): ChannelProviderMeta[] {
  const used = new Set(rows.map((row) => row.provider));
  return (meta?.providers ?? []).filter((provider) => !used.has(provider.id));
}

export type ToolCard = { name: string; detail: string };

export function toolCards(servers: readonly ProjectMcpCatalogEntry[]): ToolCard[] {
  return servers.map((server) => ({ name: server.name, detail: `${server.transport} server · .mcp.json` }));
}

export type ConnectionTotals = { connections: number; channels: number; tools: number; needsAttention: number; connectedChannels: number };

export function connectionTotals(rows: readonly ConnectionRow[], tools: readonly ToolCard[]): ConnectionTotals {
  return {
    connections: rows.length + tools.length,
    channels: rows.length,
    tools: tools.length,
    needsAttention: rows.filter((row) => row.status.tone === "needs").length,
    connectedChannels: rows.filter((row) => row.status.tone === "ok").length,
  };
}

export function footerText(totals: ConnectionTotals): string {
  if (totals.connections === 0) return "No connections yet";
  const parts = [
    `${totals.connections} connection${totals.connections === 1 ? "" : "s"}`,
    `${totals.channels} channel${totals.channels === 1 ? "" : "s"}`,
    `${totals.tools} tool${totals.tools === 1 ? "" : "s"}`,
  ];
  if (totals.needsAttention > 0) parts.push(`${totals.needsAttention} needs attention`);
  return parts.join(" · ");
}

/** The stage `channels:` entry that sends through a connection. */
export function usageSnippet(provider: string, connectionId: string, meta: ChannelMeta | null | undefined): string {
  const example = providerOf(meta, provider)?.stageExample ?? "    to: <target>";
  return `channels:
  - connection: ${connectionId}
${example}
    operations: [send]
`;
}

/** What to do about the last failure, from the host's catalogue. */
export function fixHint(code: string | undefined, meta: ChannelMeta | null | undefined): string | undefined {
  return errorHint(meta, code);
}

export type DetailFact = { label: string; value: string; mono?: boolean };

export function detailFacts(
  connection: { id: string; provider: string; displayName: string; enabled: boolean; identity?: string; credential?: string },
  meta?: ChannelMeta | null,
): DetailFact[] {
  return [
    { label: "Provider", value: providerLabel(meta, connection.provider) },
    { label: "Connection id", value: connection.id, mono: true },
    ...(connection.identity ? [{ label: "Identity", value: connection.identity, mono: true }] : []),
    ...(connection.credential ? [{ label: "Shared credential", value: connection.credential, mono: true }] : []),
    { label: "Enabled", value: connection.enabled ? "Yes" : "No" },
  ];
}

export type FormValues = Record<string, string>;

export function missingFields(provider: ChannelProviderMeta, values: FormValues, savedCredential: boolean): string[] {
  return provider.fields
    .filter((field) => field.required && !(savedCredential && field.target === "credential") && !(values[field.key] ?? "").trim())
    .map((field) => field.key);
}

export function buildNewConnection(
  provider: ChannelProviderMeta,
  values: FormValues,
  options: { savedCredential?: string; id?: string; displayName?: string } = {},
): NewChannelConnection {
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const credentialSecrets: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = (values[field.key] ?? field.defaultValue ?? "").trim();
    if (!value) continue;
    if (field.target === "config") config[field.key] = value;
    else if (field.target === "secret") secrets[field.key] = value;
    else if (!options.savedCredential) credentialSecrets[field.key] = value;
  }
  return {
    provider: provider.id,
    ...(options.id ? { id: options.id } : {}),
    ...(options.displayName ? { displayName: options.displayName } : {}),
    config,
    secrets,
    ...(options.savedCredential ? { credential: options.savedCredential } : Object.keys(credentialSecrets).length ? { credential: { secrets: credentialSecrets } } : {}),
  };
}

/** A request failure in the host's words, with its hint when it has one. */
export function apiErrorMessage(code: string, meta: ChannelMeta | null | undefined): string {
  const reason = meta?.errors[code]?.reason;
  if (!reason) return `Request failed (${code})`;
  const hint = errorHint(meta, code);
  return hint ? `${reason}. ${hint}` : reason;
}

export { errorReason };
