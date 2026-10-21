import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const MEMORY_STORE_BASH_DENIED =
  "The memory store cannot be accessed with shell commands. Use the memory tools.";

const MEMORY_STORE_SEGMENT = /\/memories\/[a-z][a-z0-9_-]{0,63}\b/;

export function memoryStorePathInCommand(command: string, home: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const store = path.resolve(path.join(home, "memories"));
  const variants = [store, store.split(path.sep).join("/")];
  for (const candidate of variants) {
    if (candidate.length > 0 && trimmed.includes(candidate)) return true;
  }
  if (MEMORY_STORE_SEGMENT.test(trimmed)) return true;
  if (/\$STAGEFLOW_HOME\/memories\b/.test(trimmed) || /\$\{STAGEFLOW_HOME\}\/memories\b/.test(trimmed)) {
    return true;
  }
  return false;
}

export function createMemoryStoreBashDenyExtension(options: { home: string }): ExtensionFactory {
  const { home } = options;
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "bash") return undefined;
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string") return undefined;
      if (!memoryStorePathInCommand(command, home)) return undefined;
      return { block: true, reason: MEMORY_STORE_BASH_DENIED };
    });
  };
}
