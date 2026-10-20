import { MemoryError, type MemoryHost, type MemoryMeta } from "./host.js";

/** What a stage or agent session is allowed to do with the memories attached to it. */
export type StageMemory = {
  attachments: MemoryMeta[];
  read(id: string): Promise<string>;
  replace(id: string, content: string): Promise<void>;
};

export async function bindStageMemory(host: MemoryHost, ids: readonly string[]): Promise<StageMemory> {
  const attachments: MemoryMeta[] = [];
  for (const id of ids) attachments.push(await host.readMeta(id));
  const allowed = new Set(ids);
  return {
    attachments,
    async read(id) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      return host.read(id);
    },
    async replace(id, content) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      await host.replace(id, content);
    },
  };
}

export function formatMemoryPrompt(attachments: readonly MemoryMeta[]): string {
  const lines = attachments.map((item) => `- ${item.id}: ${item.description}`);
  return [
    "Memories you can read and replace:",
    ...lines,
    "Call read_memory with the memory id to get the page. Call replace_memory with the full new page. The page is not shown here. Do not try to open memory files yourself.",
  ].join("\n");
}
