/**
 * What a connection really talks to. Two connections can point at the same AgentMail inbox or the same Photon
 * project; one stream and one agent may serve such a pair, so they share an identity. Other providers are
 * identified by the connection itself.
 */
export function channelIdentity(connection: {
  id: string;
  provider: string;
  config?: unknown;
  credential?: { secrets: Record<string, string> } | undefined;
}): string {
  if (connection.provider === "agentmail") {
    const config = (connection.config ?? {}) as { inbox?: string; region?: string };
    if (config.inbox) return `agentmail:${config.region ?? "us"}:${config.inbox.trim().toLowerCase()}`;
  }
  if (connection.provider === "imessage") {
    const project = connection.credential?.secrets.projectId;
    if (project) return `imessage:${project}`;
  }
  return `${connection.provider}:${connection.id}`;
}
