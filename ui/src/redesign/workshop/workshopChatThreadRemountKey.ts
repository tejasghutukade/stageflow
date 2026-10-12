/**
 * Remount key for Workshop chat ThreadRuntime / WorkshopChatIsland.
 * Must not include sessionId: ensureChatSession sets sessionId mid-send on the
 * first message; including it remounts the thread and drops the in-flight turn.
 * Intentional resets bump threadEpoch instead.
 */
export function workshopChatThreadRemountKey(threadEpoch: number): string {
  return String(threadEpoch);
}
