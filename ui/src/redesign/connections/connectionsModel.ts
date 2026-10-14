import type { ChannelConnectionListing, ConnectionListing, ProjectMcpCatalogEntry } from "../../api";
import { channelStatus, type ChannelStatus } from "../../pages/channelStatus";

export type ProviderId = "agentmail" | "slack" | "imessage" | "whatsapp" | "telegram";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  /** Shown on the "not connected" tile. */
  blurb: string;
  viaPhoton: boolean;
  yaml: string;
  env: string[];
};

const PHOTON_CREDENTIAL = `credentials:
  - id: photon-main
    provider: photon
    secrets:
      projectId: env:PHOTON_PROJECT_ID
      projectSecret: env:PHOTON_PROJECT_SECRET
`;

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "agentmail", label: "AgentMail", blurb: "Not connected · send email from an inbox", viaPhoton: false,
    env: ["AGENTMAIL_API_KEY"],
    yaml: `connections:
  - id: support-inbox
    provider: agentmail
    config:
      inbox: support@agentmail.to
    secrets:
      apiKey: env:AGENTMAIL_API_KEY
`,
  },
  {
    id: "slack", label: "Slack", blurb: "Not connected · post as a bot", viaPhoton: false,
    env: ["SLACK_BOT_TOKEN"],
    yaml: `connections:
  - id: ops-slack
    provider: slack
    secrets:
      botToken: env:SLACK_BOT_TOKEN
`,
  },
  {
    id: "imessage", label: "iMessage", blurb: "Not connected · via Photon", viaPhoton: true,
    env: ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"],
    yaml: `${PHOTON_CREDENTIAL}connections:
  - id: alerts-imessage
    provider: imessage
    credential: photon-main
`,
  },
  {
    id: "whatsapp", label: "WhatsApp Business", blurb: "Not connected · via Photon", viaPhoton: true,
    env: ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"],
    yaml: `${PHOTON_CREDENTIAL}connections:
  - id: orders-whatsapp
    provider: whatsapp
    credential: photon-main
`,
  },
  {
    id: "telegram", label: "Telegram", blurb: "Not connected · bot token", viaPhoton: false,
    env: ["TELEGRAM_BOT_TOKEN"],
    yaml: `connections:
  - id: alerts-telegram
    provider: telegram
    secrets:
      botToken: env:TELEGRAM_BOT_TOKEN
`,
  },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export type ConnectionRow = {
  key: string;
  id: string;
  kind: "channel" | "email";
  /** Provider id for channels; "email" for IMAP/SMTP accounts. */
  provider: string;
  name: string;
  secondary: string;
  viaPhoton: boolean;
  status: ChannelStatus;
  checkedAt?: string;
  checkable: boolean;
};

export function channelRows(
  channels: readonly ChannelConnectionListing[],
  emailAccounts: readonly ConnectionListing[],
): ConnectionRow[] {
  const rows: ConnectionRow[] = channels.map((connection) => ({
    key: `channel:${connection.id}`,
    id: connection.id,
    kind: "channel",
    provider: connection.provider,
    name: providerInfo(connection.provider)?.label ?? connection.provider,
    secondary: connection.identity ? `${connection.identity} · ${connection.id}` : connection.id,
    viaPhoton: providerInfo(connection.provider)?.viaPhoton ?? false,
    status: channelStatus(connection),
    ...(connection.health ? { checkedAt: connection.health.checkedAt } : {}),
    checkable: connection.enabled,
  }));
  for (const account of emailAccounts) {
    rows.push({
      key: `email:${account.id}`,
      id: account.id,
      kind: "email",
      provider: "email",
      name: account.displayName,
      secondary: `${account.address} · IMAP/SMTP`,
      viaPhoton: false,
      status: account.enabled ? { label: "Enabled", tone: "muted" } : { label: "Disabled", tone: "muted" },
      checkable: false,
    });
  }
  return rows;
}

/** Providers that have no connection yet, offered as dashed tiles. */
export function availableProviders(rows: readonly ConnectionRow[]): ProviderInfo[] {
  const used = new Set(rows.map((row) => row.provider));
  return PROVIDERS.filter((provider) => !used.has(provider.id));
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

const USAGE_TARGETS: Record<string, string> = {
  agentmail: "    to: [oncall@acme.com]",
  slack: "    to: C0123ABCD",
  telegram: '    to: "123456789"',
  imessage: '    to: "+14155550123"',
  whatsapp: `    to: "+14155550123"
    template:
      name: order_update
      languageCode: en_US
      bodyParams: ["{{message}}"]`,
};

/** The stage `channels:` entry that sends through a connection. */
export function usageSnippet(provider: string, connectionId: string): string {
  return `channels:
  - connection: ${connectionId}
${USAGE_TARGETS[provider] ?? "    to: <target>"}
    operations: [send]
`;
}

const FIX_HINTS: Record<string, string> = {
  CHANNEL_SECRET_UNAVAILABLE: "Set the environment variable each secret in connections.yaml names (or its _FILE form) on the host, then check again.",
  CHANNEL_AUTH_FAILED: "The provider rejected the credential. Replace the secret on the host with a valid one, then check again.",
  CHANNEL_UNAUTHORIZED: "The credential works but lacks a permission this provider needs. Grant it in the provider, then check again.",
  CHANNEL_INVALID_INPUT: "The settings in connections.yaml do not match the provider account (for example an unknown inbox or a different workspace). Fix the entry and restart.",
  CHANNEL_PROVIDER_UNSUPPORTED: "This Stageflow version cannot use this provider, or its SDK is not installed (iMessage and WhatsApp need spectrum-ts).",
  CHANNEL_CONNECTION_FAILED: "Stageflow could not reach the provider. This is usually temporary; check the network and try again.",
  CHANNEL_TIMEOUT: "The provider did not answer in time. Try again.",
  CHANNEL_RATE_LIMIT: "The provider is rate limiting this account. Wait and try again.",
};

export function fixHint(code: string | undefined): string | undefined {
  return code ? FIX_HINTS[code] : undefined;
}

export type DetailFact = { label: string; value: string; mono?: boolean };

export function detailFacts(connection: { id: string; provider: string; displayName: string; enabled: boolean; identity?: string; credential?: string }): DetailFact[] {
  const info = providerInfo(connection.provider);
  return [
    { label: "Provider", value: info?.label ?? connection.provider },
    { label: "Connection id", value: connection.id, mono: true },
    ...(connection.identity ? [{ label: "Identity", value: connection.identity, mono: true }] : []),
    ...(connection.credential ? [{ label: "Shared credential", value: connection.credential, mono: true }] : []),
    { label: "Enabled", value: connection.enabled ? "Yes" : "No" },
  ];
}
