import { MemoryError, type MemoryCardHit, type MemoryHost, type MemoryMeta } from "./host.js";

/** What a stage or agent session is allowed to do with the memories attached to it. */
export type StageMemory = {
  attachments: MemoryMeta[];
  read(id: string): Promise<string>;
  replace(id: string, content: string): Promise<void>;
  addCard(id: string, key: string, body: string): Promise<void>;
  updateCard(id: string, key: string, body: string): Promise<void>;
  readCard(id: string, key: string): Promise<string>;
  searchCards(id: string, query: string): Promise<MemoryCardHit[]>;
};

function requireAttached(allowed: ReadonlySet<string>, id: string): void {
  if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
}

export async function bindStageMemory(host: MemoryHost, ids: readonly string[]): Promise<StageMemory> {
  const attachments: MemoryMeta[] = [];
  for (const id of ids) attachments.push(await host.readMeta(id));
  const allowed = new Set(ids);
  return {
    attachments,
    async read(id) {
      requireAttached(allowed, id);
      return host.read(id);
    },
    async replace(id, content) {
      requireAttached(allowed, id);
      await host.replace(id, content);
    },
    async addCard(id, key, body) {
      requireAttached(allowed, id);
      await host.addCard(id, key, body);
    },
    async updateCard(id, key, body) {
      requireAttached(allowed, id);
      await host.updateCard(id, key, body);
    },
    async readCard(id, key) {
      requireAttached(allowed, id);
      return host.readCard(id, key);
    },
    async searchCards(id, query) {
      requireAttached(allowed, id);
      return host.searchCards(id, query);
    },
  };
}

export function formatMemoryPrompt(attachments: readonly MemoryMeta[]): string {
  const lines = attachments.map((item) => `- ${item.id}: ${item.description}`);
  return [
    "Memories you can read and replace:",
    ...lines,
    "Call read_memory with the memory id to get the page. Call replace_memory with the full new page.",
    "Call add_memory_card, update_memory_card, and read_memory_card with the memory id and the card key. Call search_memory_cards with the memory id and a query.",
    "The page is not shown here. Card bodies are not shown here. Do not try to open memory files yourself.",
  ].join("\n");
}
