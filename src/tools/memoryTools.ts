import { Type } from "typebox";
import { MEMORY_KEY_MAX, MEMORY_PAGE_CAP } from "../memory/ids.js";
import { MemoryError, type MemoryErrorCode } from "../memory/host.js";
import { formatMemoryPrompt, type StageMemory } from "../memory/access.js";

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean };

function fault(error: unknown): { code: MemoryErrorCode } {
  return { code: error instanceof MemoryError ? error.code : "MEMORY_UNREADABLE" };
}

function refused(error: unknown): ToolResult {
  const details = fault(error);
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
}

export function createReadMemoryTool(memory: StageMemory) {
  return {
    name: "read_memory",
    label: "Read memory",
    description: "Read the whole page of a memory attached to this stage or agent. Pass the memory id.",
    parameters: Type.Object({
      memory: Type.String(),
    }),
    async execute(_toolCallId: string, input: unknown): Promise<ToolResult> {
      try {
        const id = (input as { memory?: unknown }).memory;
        if (typeof id !== "string") throw new MemoryError("MEMORY_INVALID_ID");
        const body = await memory.read(id);
        return { content: [{ type: "text" as const, text: body }], details: { memory: id } };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

export function createReplaceMemoryTool(memory: StageMemory) {
  return {
    name: "replace_memory",
    label: "Replace memory",
    description: "Replace the whole page of a memory attached to this stage or agent. Pass the memory id and the full new page. A page over the character cap is refused.",
    parameters: Type.Object({
      memory: Type.String(),
      content: Type.String({ maxLength: MEMORY_PAGE_CAP }),
    }),
    async execute(_toolCallId: string, input: unknown): Promise<ToolResult> {
      try {
        const args = input as { memory?: unknown; content?: unknown };
        if (typeof args.memory !== "string") throw new MemoryError("MEMORY_INVALID_ID");
        if (typeof args.content !== "string") throw new MemoryError("MEMORY_TOO_LARGE");
        await memory.replace(args.memory, args.content);
        return { content: [{ type: "text" as const, text: "ok" }], details: { memory: args.memory } };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

function cardWriteArgs(input: unknown): { memory: string; key: string; content: string } {
  const args = input as { memory?: unknown; key?: unknown; content?: unknown };
  if (typeof args.memory !== "string") throw new MemoryError("MEMORY_INVALID_ID");
  if (typeof args.key !== "string") throw new MemoryError("MEMORY_INVALID_KEY");
  if (typeof args.content !== "string") throw new MemoryError("MEMORY_TOO_LARGE");
  return { memory: args.memory, key: args.key, content: args.content };
}

const cardParameters = Type.Object({
  memory: Type.String(),
  key: Type.String({ maxLength: MEMORY_KEY_MAX }),
  content: Type.String({ maxLength: MEMORY_PAGE_CAP }),
});

export function createAddMemoryCardTool(memory: StageMemory) {
  return {
    name: "add_memory_card",
    label: "Add memory card",
    description: "Add a card to a memory attached to this stage or agent. Pass the memory id, the card key, and the card body. A second add of the same key is refused.",
    parameters: cardParameters,
    async execute(_toolCallId: string, input: unknown): Promise<ToolResult> {
      try {
        const args = cardWriteArgs(input);
        await memory.addCard(args.memory, args.key, args.content);
        return { content: [{ type: "text" as const, text: "ok" }], details: { memory: args.memory, key: args.key } };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

export function createUpdateMemoryCardTool(memory: StageMemory) {
  return {
    name: "update_memory_card",
    label: "Update memory card",
    description: "Replace the current body of a card on a memory attached to this stage or agent. Pass the memory id, the card key, and the new body.",
    parameters: cardParameters,
    async execute(_toolCallId: string, input: unknown): Promise<ToolResult> {
      try {
        const args = cardWriteArgs(input);
        await memory.updateCard(args.memory, args.key, args.content);
        return { content: [{ type: "text" as const, text: "ok" }], details: { memory: args.memory, key: args.key } };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

export function createReadMemoryCardTool(memory: StageMemory) {
  return {
    name: "read_memory_card",
    label: "Read memory card",
    description: "Read the current body of a card on a memory attached to this stage or agent. Pass the memory id and the card key.",
    parameters: Type.Object({
      memory: Type.String(),
      key: Type.String({ maxLength: MEMORY_KEY_MAX }),
    }),
    async execute(_toolCallId: string, input: unknown): Promise<ToolResult> {
      try {
        const args = input as { memory?: unknown; key?: unknown };
        if (typeof args.memory !== "string") throw new MemoryError("MEMORY_INVALID_ID");
        if (typeof args.key !== "string") throw new MemoryError("MEMORY_INVALID_KEY");
        const body = await memory.readCard(args.memory, args.key);
        return { content: [{ type: "text" as const, text: body }], details: { memory: args.memory, key: args.key } };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

export function createSearchMemoryCardsTool(memory: StageMemory) {
  return {
    name: "search_memory_cards",
    label: "Search memory cards",
    description: "Search the current cards of a memory attached to this stage or agent. Pass the memory id and a query. Returns matching keys and short snippets.",
    parameters: Type.Object({
      memory: Type.String(),
      query: Type.String(),
    }),
    async execute(_toolCallId: string, input: unknown): Promise<ToolResult> {
      try {
        const args = input as { memory?: unknown; query?: unknown };
        if (typeof args.memory !== "string") throw new MemoryError("MEMORY_INVALID_ID");
        if (typeof args.query !== "string") throw new MemoryError("MEMORY_UNREADABLE");
        const hits = await memory.searchCards(args.memory, args.query);
        return { content: [{ type: "text" as const, text: JSON.stringify(hits) }], details: { memory: args.memory } };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

/** Prompt text and tools for one attached-memory session. */
export function memorySession(memory: StageMemory) {
  return {
    prompt: formatMemoryPrompt(memory.attachments),
    tools: createAttachedMemoryTools(memory),
  };
}

export function createAttachedMemoryTools(memory: StageMemory) {
  return [
    createReadMemoryTool(memory),
    createReplaceMemoryTool(memory),
    createAddMemoryCardTool(memory),
    createUpdateMemoryCardTool(memory),
    createReadMemoryCardTool(memory),
    createSearchMemoryCardsTool(memory),
  ];
}
