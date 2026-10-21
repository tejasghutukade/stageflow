import { MemoryError, type MemoryCardHit, type MemoryHost, type MemoryMeta } from "./host.js";

/** What a stage or agent session is allowed to do with the memories attached to it. */
export type StageMemory = {
  attachments: MemoryMeta[];
  refreshAttachments(): Promise<MemoryMeta[]>;
  read(id: string): Promise<string>;
  replace(id: string, content: string): Promise<void>;
  addCard(id: string, key: string, body: string): Promise<void>;
  updateCard(id: string, key: string, body: string): Promise<void>;
  readCard(id: string, key: string): Promise<string>;
  searchCards(id: string, query: string): Promise<MemoryCardHit[]>;
};

/** Unchecked reads and writes. The attachment allowlist sits in front of this. */
export type MemoryPort = {
  meta(id: string): Promise<MemoryMeta>;
  read(id: string): Promise<string>;
  replace(id: string, content: string): Promise<void>;
  addCard(id: string, key: string, body: string): Promise<void>;
  updateCard(id: string, key: string, body: string): Promise<void>;
  readCard(id: string, key: string): Promise<string>;
  searchCards(id: string, query: string): Promise<MemoryCardHit[]>;
};

const MEMORY_VERBS = [
  "memory.read",
  "memory.replace",
  "memory.meta",
  "memory.addCard",
  "memory.updateCard",
  "memory.readCard",
  "memory.searchCards",
] as const;

export type MemoryVerb = (typeof MEMORY_VERBS)[number];

export function isMemoryVerb(type: string | undefined): type is MemoryVerb {
  return type !== undefined && (MEMORY_VERBS as readonly string[]).includes(type);
}

function gate(allowed: ReadonlySet<string>, id: string): void {
  if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
}

/** One allowlist in front of either the host or the worker port. */
export async function attachMemory(ids: readonly string[], port: MemoryPort): Promise<StageMemory> {
  const attachments: MemoryMeta[] = [];
  for (const id of ids) attachments.push(await port.meta(id));
  const allowed = new Set(ids);
  return {
    attachments,
    async refreshAttachments() {
      const next: MemoryMeta[] = [];
      for (const id of ids) next.push(await port.meta(id));
      attachments.length = 0;
      attachments.push(...next);
      return next;
    },
    async read(id) {
      gate(allowed, id);
      return port.read(id);
    },
    async replace(id, content) {
      gate(allowed, id);
      await port.replace(id, content);
    },
    async addCard(id, key, body) {
      gate(allowed, id);
      await port.addCard(id, key, body);
    },
    async updateCard(id, key, body) {
      gate(allowed, id);
      await port.updateCard(id, key, body);
    },
    async readCard(id, key) {
      gate(allowed, id);
      return port.readCard(id, key);
    },
    async searchCards(id, query) {
      gate(allowed, id);
      return port.searchCards(id, query);
    },
  };
}

export function bindStageMemory(host: MemoryHost, ids: readonly string[]): Promise<StageMemory> {
  return attachMemory(ids, {
    meta: (id) => host.readMeta(id),
    read: (id) => host.read(id),
    replace: (id, content) => host.replace(id, content),
    addCard: (id, key, body) => host.addCard(id, key, body),
    updateCard: (id, key, body) => host.updateCard(id, key, body),
    readCard: (id, key) => host.readCard(id, key),
    searchCards: (id, query) => host.searchCards(id, query),
  });
}

type MemoryCallInput = { memory?: unknown; content?: unknown; key?: unknown; query?: unknown };

/** Parent-side dispatch for a stage worker. Refuses an id the stage was not given. */
export async function runMemoryRequest(
  host: MemoryHost,
  allowed: readonly string[],
  type: MemoryVerb,
  input: unknown,
): Promise<{ body?: string; meta?: MemoryMeta; hits?: MemoryCardHit[] }> {
  const args = (input ?? {}) as MemoryCallInput;
  const id = args.memory;
  if (typeof id !== "string" || !allowed.includes(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
  if (type === "memory.read") return { body: await host.read(id) };
  if (type === "memory.replace") {
    if (typeof args.content !== "string") throw new MemoryError("MEMORY_UNREADABLE");
    await host.replace(id, args.content);
    return {};
  }
  if (type === "memory.addCard" || type === "memory.updateCard") {
    if (typeof args.key !== "string") throw new MemoryError("MEMORY_INVALID_KEY");
    if (typeof args.content !== "string") throw new MemoryError("MEMORY_UNREADABLE");
    if (type === "memory.addCard") await host.addCard(id, args.key, args.content);
    else await host.updateCard(id, args.key, args.content);
    return {};
  }
  if (type === "memory.readCard") {
    if (typeof args.key !== "string") throw new MemoryError("MEMORY_INVALID_KEY");
    return { body: await host.readCard(id, args.key) };
  }
  if (type === "memory.searchCards") {
    const query = typeof args.query === "string" ? args.query : "";
    return { hits: await host.searchCards(id, query) };
  }
  return { meta: await host.readMeta(id) };
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
