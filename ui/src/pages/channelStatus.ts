import type { ChannelConnectionListing, ChannelMeta } from "../api";
import { errorReason } from "../redesign/connections/channelMeta";

export type ChannelStatus = { label: string; tone: "ok" | "needs" | "muted"; detail?: string };

/**
 * What the host last observed. "Not checked yet" never claims the connection works. The reason
 * text comes from the host's error catalogue, so it can never disagree with the server.
 */
export function channelStatus(connection: ChannelConnectionListing, meta?: ChannelMeta | null): ChannelStatus {
  if (!connection.enabled) return { label: "Disabled", tone: "muted" };
  const health = connection.health;
  if (!health) return { label: "Not checked yet", tone: "muted" };
  if (health.state === "ok") return { label: "Connected", tone: "ok" };
  if (health.error?.code === "CHANNEL_SECRET_UNAVAILABLE") {
    return { label: "Not connected", tone: "muted", detail: `Finish setup: ${errorReason(meta, health.error.code)}` };
  }
  return { label: "Connection broken", tone: "needs", ...(health.error ? { detail: errorReason(meta, health.error.code) } : {}) };
}

export function ageLabel(checkedAt: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 1000));
  if (Number.isNaN(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
