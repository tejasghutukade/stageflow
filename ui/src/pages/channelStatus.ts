import type { ChannelConnectionListing } from "../api";

export const PROVIDER_LABELS: Record<string, string> = {
  agentmail: "AgentMail",
  slack: "Slack",
  telegram: "Telegram",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
};

const CODE_MESSAGES: Record<string, string> = {
  CHANNEL_AUTH_FAILED: "Credentials were rejected",
  CHANNEL_UNAUTHORIZED: "Credentials lack a required permission",
  CHANNEL_SECRET_UNAVAILABLE: "A secret named in connections.yaml is not set on the host",
  CHANNEL_CONNECTION_FAILED: "Could not reach the provider",
  CHANNEL_TIMEOUT: "The provider did not answer in time",
  CHANNEL_RATE_LIMIT: "The provider is rate limiting",
  CHANNEL_INVALID_INPUT: "The connection settings do not match the provider account",
  CHANNEL_PROVIDER_UNSUPPORTED: "This provider is not supported by this Stageflow version",
  CHANNEL_INVALID_CONFIG: "connections.yaml could not be loaded",
  CHANNEL_STORAGE_FAILED: "connections.yaml could not be read",
  CHANNEL_RESOURCE_LIMIT: "connections.yaml is too large",
};

export function codeMessage(code: string): string {
  return CODE_MESSAGES[code] ?? code;
}

export type ChannelStatus = { label: string; tone: "ok" | "fail" | "muted"; detail?: string };

/** What the host last observed. "Not checked yet" never claims the connection works. */
export function channelStatus(connection: ChannelConnectionListing): ChannelStatus {
  if (!connection.enabled) return { label: "Disabled", tone: "muted" };
  const health = connection.health;
  if (!health) return { label: "Not checked yet", tone: "muted" };
  if (health.state === "ok") return { label: "Connected", tone: "ok" };
  return { label: "Check failed", tone: "fail", detail: health.error ? codeMessage(health.error.code) : undefined };
}

export function ageLabel(checkedAt: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 1000));
  if (Number.isNaN(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
