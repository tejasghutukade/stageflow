/** One-shot flag so the detail page can say "Agent created" right after the create page saves. */
let createdAgentId: string | null = null;

export function markAgentCreated(id: string): void {
  createdAgentId = id;
}

export function consumeAgentCreated(id: string): boolean {
  if (createdAgentId !== id) return false;
  createdAgentId = null;
  return true;
}
