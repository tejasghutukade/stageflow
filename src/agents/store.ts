import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AgentRevisionRecord = {
  revision: number;
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  description?: string;
  createdAt: string;
};

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type AgentSessionRecord = {
  id: string;
  agentId: string;
  revision: number;
  backend: "pi" | "claude";
  status: "open" | "running" | "held";
  messages: AgentMessage[];
};

export type AgentRecord = {
  id: string;
  archived: boolean;
  currentRevision: number;
  revisions: AgentRevisionRecord[];
  sessions: AgentSessionRecord[];
  error?: { code: string; message: string };
};

export type AgentProjectState = {
  agents: Record<string, AgentRecord>;
};

export function agentProjectKey(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
}

export class AgentStore {
  constructor(private readonly homeDir: string) {}

  private file(projectRoot: string): string {
    return path.join(this.homeDir, "agents", `${agentProjectKey(projectRoot)}.json`);
  }

  async load(projectRoot: string): Promise<AgentProjectState> {
    try {
      const parsed = JSON.parse(await readFile(this.file(projectRoot), "utf8")) as AgentProjectState;
      if (!parsed || typeof parsed !== "object" || !parsed.agents) return { agents: {} };
      return parsed;
    } catch {
      return { agents: {} };
    }
  }

  async save(projectRoot: string, state: AgentProjectState): Promise<void> {
    const file = this.file(projectRoot);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, file);
  }
}
