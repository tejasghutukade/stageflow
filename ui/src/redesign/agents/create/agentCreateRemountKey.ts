/** Remount key for AgentCreatePage — matches edit/session/run identity keys. */
export function agentCreateRemountKey(authorSessionId?: string): string {
  return authorSessionId ?? "new";
}
