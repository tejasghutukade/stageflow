/** Display formatting shared by the agent pages. */

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatTokens(tokens: number): string {
  if (tokens === 0) return "—";
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd <= 0) return "$0.00";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  // A cheap model costs fractions of a cent per turn: keep two significant digits so it does not read as free.
  return `$${usd.toFixed(Math.min(8, 1 + Math.ceil(-Math.log10(usd))))}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds % 60)} s`;
}

const SOURCES: Record<string, string> = {
  console: "Console",
  cli: "CLI",
  mcp: "MCP",
  web: "Web chat",
  schedule: "Schedule",
  email: "Email",
  slack: "Slack",
  telegram: "Telegram",
  photon: "iMessage",
  agentmail: "AgentMail",
};

export function sourceLabel(source: string): string {
  return SOURCES[source] ?? source;
}

/** Subtitle of a session row: who it came from, then the short id. Web visitors are anonymous ids. */
export function sessionSubtitle(session: { id: string; source: string; sourceRef: string | null }): string {
  const who = session.source === "web" && session.sourceRef ? `Visitor ${session.sourceRef.slice(0, 8)}` : session.sourceRef;
  return [who, shortSessionId(session.id)].filter(Boolean).join(" · ");
}

export function shortSessionId(id: string): string {
  return id.startsWith("ses_") && id.length > 8 ? id.slice(0, 8) : id;
}
