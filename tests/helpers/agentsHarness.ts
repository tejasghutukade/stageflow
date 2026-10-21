import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { AgentService, type AgentEnvironment } from "../../src/agents/service.js";
import type { ConversationBackend } from "../../src/agents/sessions.js";
import { AgentStore } from "../../src/agents/store.js";
import { createRunStoreWithConnection } from "../../src/runstore/createStore.js";

export type AgentsFixture = {
  home: string;
  project: string;
  connection: Database.Database;
  store: AgentStore;
  service: AgentService;
  clock: { now: Date; advance(ms: number): void };
  writeAgentFile(id: string, yaml: string): Promise<void>;
  cleanup(): Promise<void>;
};

/** Real SQLite store (migrated) in a temp home, a temp project with `agents/`, and a controllable clock. */
export async function agentsFixture(options: { environment?: AgentEnvironment } = {}): Promise<AgentsFixture> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-agents-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-agents-project-"));
  await mkdir(path.join(project, "agents"), { recursive: true });
  const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
  const clock = {
    now: new Date("2026-10-15T12:00:00.000Z"),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const store = new AgentStore(connection);
  const service = new AgentService({
    store,
    now: () => clock.now,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  return {
    home,
    project,
    connection,
    store,
    service,
    clock,
    async writeAgentFile(id, yaml) {
      await writeFile(path.join(project, "agents", `${id}.agent.yaml`), yaml);
    },
    async cleanup() {
      connection.close();
      await Promise.all([rm(home, { recursive: true, force: true }), rm(project, { recursive: true, force: true })]);
    },
  };
}

/** Minimal valid definition body; spread overrides on top. */
export function agentInput(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `Agent ${id}`, instructions: "Be helpful.", ...overrides };
}

type ScriptContext = {
  messages: Array<{ role: string; text: string }>;
  hooks: Parameters<ConversationBackend["complete"]>[0]["hooks"];
  signal: AbortSignal;
  /** Gate + run a tool call the way the Pi runtime does; resolves with the tool output or the block reason. */
  tool(tool: string, input?: Record<string, unknown>, run?: () => string | Promise<string>): Promise<{ ran: boolean; output: string }>;
};

/** Backend that replies with a scripted function of the transcript and streams it in two deltas. */
export function scriptedBackend(
  reply: (messages: Array<{ role: string; text: string }>, ctx: ScriptContext) => string | Promise<string> = (messages) => `echo: ${messages.at(-1)!.text}`,
  usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
  extras: Partial<Pick<ConversationBackend, "judge">> = {},
): ConversationBackend & { calls: number; toolOutputs: string[] } {
  let seq = 0;
  const backend = {
    id: "pi" as const,
    calls: 0,
    toolOutputs: [] as string[],
    ...extras,
    async complete(input: Parameters<ConversationBackend["complete"]>[0]) {
      backend.calls += 1;
      const outputs: string[] = [];
      const ctx: ScriptContext = {
        messages: input.messages,
        hooks: input.hooks,
        signal: input.signal,
        async tool(tool, toolInput = {}, run = () => `ran ${tool}`) {
          const call = { id: `call_${(seq += 1)}`, tool, input: toolInput };
          const decision = await input.hooks.gate(call);
          if (!decision.allow) return { ran: false, output: decision.reason };
          input.hooks.toolStarted(call);
          const output = await run();
          outputs.push(output);
          input.hooks.toolFinished(call, { ok: true, output });
          return { ran: true, output };
        },
      };
      const text = await reply(input.messages, ctx);
      const middle = Math.ceil(text.length / 2);
      input.onDelta(text.slice(0, middle));
      input.onDelta(text.slice(middle));
      input.hooks.modelFinished({ startedAt: new Date(), endedAt: new Date(), ...usage });
      return { text, usage, toolOutputs: outputs };
    },
  };
  return backend;
}
