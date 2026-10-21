import type { AgentIssue } from "../config/loadAgent.js";
import { inspectMemorySync, memoryHome } from "./host.js";

const MESSAGE: Record<string, (id: string) => string> = {
  MEMORY_NOT_FOUND: (id) => `Memory "${id}" does not exist. Create it before attaching it.`,
  MEMORY_MISMATCH: (id) => `Memory "${id}" does not match the id in its file.`,
  MEMORY_UNREADABLE: (id) => `Memory "${id}" could not be read.`,
  MEMORY_INVALID_ID: (id) => `Memory "${id}" is not a valid id.`,
};

/** Hard errors for an agent that names a memory the data directory does not have. */
export function agentMemoryIssues(ids: readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env): AgentIssue[] {
  if (!ids?.length) return [];
  const home = memoryHome(env);
  return ids.flatMap((id, index) => {
    const inspected = inspectMemorySync(home, id);
    if (inspected.ok) return [];
    return [{
      path: `memories.${index}`,
      code: "agent.memory_unavailable",
      message: (MESSAGE[inspected.code] ?? MESSAGE.MEMORY_UNREADABLE)(id),
    }];
  });
}
