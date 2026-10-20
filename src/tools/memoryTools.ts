import { Type } from "typebox";
import { MEMORY_PAGE_CAP } from "../memory/ids.js";
import { MemoryError, type MemoryErrorCode } from "../memory/host.js";
import type { StageMemory } from "../memory/access.js";

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
