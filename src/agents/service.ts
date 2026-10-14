import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { parseAgentYaml, type AgentDefinition } from "../config/loadAgent.js";
import {
  AgentStore,
  type AgentRecord,
  type AgentRevisionRecord,
  type AgentSessionRecord,
} from "./store.js";

const INVALID = { code: "agent.invalid", message: "Agent YAML is invalid" };

export type AgentView = {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  revision: number;
  archived: boolean;
  description?: string;
  error?: { code: string; message: string };
};

export type AgentMutation =
  | { ok: true; agent: AgentView }
  | { ok: false; code: string };

export type OpenSessionResult =
  | { ok: true; session: AgentSessionRecord }
  | { ok: false; code: string };

export type StartTurnResult =
  | { ok: true; turnId: string }
  | { ok: false; code: string };

function sameDefinition(revision: AgentRevisionRecord | undefined, next: AgentDefinition): boolean {
  if (!revision) return false;
  return (
    revision.name === next.name &&
    revision.instructions === next.instructions &&
    revision.enabled === next.enabled &&
    revision.description === next.description
  );
}

function viewOf(record: AgentRecord): AgentView | undefined {
  const revision = record.revisions.find((item) => item.revision === record.currentRevision);
  if (!revision) return undefined;
  return {
    id: record.id,
    name: revision.name,
    instructions: revision.instructions,
    enabled: revision.enabled,
    revision: revision.revision,
    archived: record.archived,
    ...(revision.description !== undefined ? { description: revision.description } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function blank(id: string): AgentRecord {
  return { id, archived: false, currentRevision: 0, revisions: [], sessions: [] };
}

export class AgentService {
  private readonly store: AgentStore;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(options: { homeDir: string }) {
    this.store = new AgentStore(options.homeDir);
  }

  private exclusive<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(projectRoot);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  private file(projectRoot: string, id: string): string {
    return path.join(projectRoot, "agents", `${id}.agent.yaml`);
  }

  private async writeDefinition(projectRoot: string, definition: AgentDefinition): Promise<void> {
    const directory = path.join(projectRoot, "agents");
    await mkdir(directory, { recursive: true });
    await writeFile(
      this.file(projectRoot, definition.id),
      stringify({
        id: definition.id,
        name: definition.name,
        instructions: definition.instructions,
        enabled: definition.enabled,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
      }),
    );
  }

  private async sync(projectRoot: string): Promise<Map<string, AgentRecord>> {
    const state = await this.store.load(projectRoot);
    const directory = path.join(projectRoot, "agents");
    let names: string[] = [];
    try {
      names = await readdir(directory);
    } catch {
      names = [];
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".agent.yaml")) continue;
      const idFromFile = name.slice(0, -".agent.yaml".length);
      seen.add(idFromFile);
      const record = state.agents[idFromFile] ?? blank(idFromFile);
      let text = "";
      try {
        text = await readFile(path.join(directory, name), "utf8");
      } catch {
        record.error = INVALID;
        state.agents[idFromFile] = record;
        continue;
      }
      const parsed = parseAgentYaml(text);
      if (!parsed.ok || parsed.value.id !== idFromFile) {
        record.error = INVALID;
        state.agents[idFromFile] = record;
        continue;
      }
      delete record.error;
      const current = record.revisions.find((item) => item.revision === record.currentRevision);
      if (!sameDefinition(current, parsed.value)) {
        const revision = record.currentRevision + 1;
        record.revisions.push({
          revision,
          createdAt: new Date().toISOString(),
          ...parsed.value,
        });
        record.currentRevision = revision;
      }
      record.archived = false;
      state.agents[idFromFile] = record;
    }
    for (const record of Object.values(state.agents)) {
      if (!seen.has(record.id) && record.currentRevision > 0) record.archived = true;
    }
    await this.store.save(projectRoot, state);
    return new Map(Object.entries(state.agents));
  }

  async list(projectRoot: string): Promise<AgentView[]> {
    return this.exclusive(projectRoot, async () => {
      const agents = await this.sync(projectRoot);
      return [...agents.values()].flatMap((record) => {
        const view = viewOf(record);
        return view ? [view] : [];
      });
    });
  }

  async get(projectRoot: string, id: string): Promise<AgentView | undefined> {
    return this.exclusive(projectRoot, async () => viewOf((await this.sync(projectRoot)).get(id) ?? blank(id)));
  }

  async revision(
    projectRoot: string,
    id: string,
    revision: number,
  ): Promise<AgentRevisionRecord | undefined> {
    return this.exclusive(projectRoot, async () => {
      const record = (await this.sync(projectRoot)).get(id);
      return record?.revisions.find((item) => item.revision === revision);
    });
  }

  async create(
    projectRoot: string,
    input: { id: string; name: string; instructions: string; description?: string },
  ): Promise<AgentView> {
    return this.exclusive(projectRoot, async () => {
      const definition: AgentDefinition = {
        id: input.id,
        name: input.name,
        instructions: input.instructions,
        enabled: false,
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      if (!parseAgentYaml(stringify(definition)).ok) {
        throw Object.assign(new Error("Agent YAML is invalid"), { code: "agent.invalid" });
      }
      try {
        await access(this.file(projectRoot, definition.id));
        throw Object.assign(new Error("Agent already exists"), { code: "agent.exists" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.writeDefinition(projectRoot, definition);
      const view = viewOf((await this.sync(projectRoot)).get(definition.id) ?? blank(definition.id));
      if (!view) throw Object.assign(new Error("Agent YAML is invalid"), { code: "agent.invalid" });
      return view;
    });
  }

  async save(
    projectRoot: string,
    id: string,
    input: { baseRevision: number; name: string; instructions: string; description?: string },
  ): Promise<AgentMutation> {
    return this.exclusive(projectRoot, async () => {
      const current = viewOf((await this.sync(projectRoot)).get(id) ?? blank(id));
      if (!current || current.revision === 0) return { ok: false, code: "agent.not_found" };
      if (current.archived) return { ok: false, code: "agent.archived" };
      if (current.revision !== input.baseRevision) return { ok: false, code: "agent.conflict" };
      await this.writeDefinition(projectRoot, {
        id,
        name: input.name,
        instructions: input.instructions,
        enabled: current.enabled,
        ...(input.description !== undefined
          ? { description: input.description }
          : current.description !== undefined
            ? { description: current.description }
            : {}),
      });
      const agent = viewOf((await this.sync(projectRoot)).get(id) ?? blank(id));
      if (!agent) return { ok: false, code: "agent.invalid" };
      return { ok: true, agent };
    });
  }

  async setEnabled(projectRoot: string, id: string, enabled: boolean): Promise<AgentMutation> {
    return this.exclusive(projectRoot, async () => {
      const current = viewOf((await this.sync(projectRoot)).get(id) ?? blank(id));
      if (!current || current.revision === 0) return { ok: false, code: "agent.not_found" };
      if (current.archived) return { ok: false, code: "agent.archived" };
      await this.writeDefinition(projectRoot, {
        id,
        name: current.name,
        instructions: current.instructions,
        enabled,
        ...(current.description !== undefined ? { description: current.description } : {}),
      });
      const agent = viewOf((await this.sync(projectRoot)).get(id) ?? blank(id));
      if (!agent) return { ok: false, code: "agent.invalid" };
      return { ok: true, agent };
    });
  }

  async archive(projectRoot: string, id: string): Promise<AgentMutation> {
    return this.exclusive(projectRoot, async () => {
      const existing = (await this.sync(projectRoot)).get(id);
      if (!existing || existing.currentRevision === 0) return { ok: false, code: "agent.not_found" };
      await rm(this.file(projectRoot, id), { force: true });
      const agent = viewOf((await this.sync(projectRoot)).get(id) ?? blank(id));
      if (!agent) return { ok: false, code: "agent.not_found" };
      return { ok: true, agent };
    });
  }

  async openSession(projectRoot: string, id: string): Promise<OpenSessionResult> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const fresh = await this.store.load(projectRoot);
      const record = fresh.agents[id];
      const current = record ? viewOf(record) : undefined;
      if (!current || current.revision === 0) return { ok: false, code: "agent.not_found" };
      if (current.archived) return { ok: false, code: "agent.archived" };
      if (!current.enabled) return { ok: false, code: "agent.disabled" };
      const session: AgentSessionRecord = {
        id: `ses_${randomBytes(8).toString("hex")}`,
        agentId: id,
        revision: current.revision,
        status: "open",
      };
      record.sessions.push(session);
      fresh.agents[id] = record;
      await this.store.save(projectRoot, fresh);
      return { ok: true, session };
    });
  }

  async startTurn(projectRoot: string, sessionId: string): Promise<StartTurnResult> {
    return this.exclusive(projectRoot, async () => {
      const fresh = await this.sync(projectRoot).then(async () => this.store.load(projectRoot));
      for (const record of Object.values(fresh.agents)) {
        const session = record.sessions.find((item) => item.id === sessionId);
        if (!session) continue;
        const current = viewOf(record);
        if (!current || current.archived) return { ok: false, code: "agent.archived" };
        if (!current.enabled) return { ok: false, code: "agent.disabled" };
        session.status = "running";
        await this.store.save(projectRoot, fresh);
        return { ok: true, turnId: `turn_${randomBytes(6).toString("hex")}` };
      }
      return { ok: false, code: "agent.session_not_found" };
    });
  }

  async getSession(projectRoot: string, sessionId: string): Promise<AgentSessionRecord | undefined> {
    return this.exclusive(projectRoot, async () => {
      const fresh = await this.store.load(projectRoot);
      for (const record of Object.values(fresh.agents)) {
        const session = record.sessions.find((item) => item.id === sessionId);
        if (session) return session;
      }
      return undefined;
    });
  }
}
