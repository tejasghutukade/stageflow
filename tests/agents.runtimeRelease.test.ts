import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { createPiAgentRuntime, type OpenSessionInput } from "../src/agents/runtime/piRuntime.js";
import type { TurnHooks } from "../src/agents/runtime/types.js";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { createAgentHostContext } from "../src/agents/hostContext.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

afterEach(() => {
  vi.useRealTimers();
});

function definition() {
  const parsed = parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help.", enabled: true });
  if (!parsed.ok) throw new Error("bad fixture");
  return parsed.value;
}

const hooks: TurnHooks = {
  gate: async () => ({ allow: true }),
  toolStarted: () => undefined,
  toolFinished: () => undefined,
  modelFinished: () => undefined,
  delegate: async () => "",
};

/** A fake backend for the runtime: every opened session counts its shutdown. */
function fake() {
  const shutdowns: string[] = [];
  let opened = 0;
  const open = async (_input: OpenSessionInput) => {
    const n = (opened += 1);
    const listeners = new Set<(event: unknown) => void>();
    return {
      toolNames: [],
      shutdown: vi.fn(async () => void shutdowns.push(`s${n}`)),
      session: {
        subscribe: (l: (event: unknown) => void) => (listeners.add(l), () => listeners.delete(l)),
        prompt: async () => listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1 } } })),
        dispose: () => undefined,
        abort: async () => undefined,
      },
    } as never;
  };
  return { open, shutdowns, opened: () => opened };
}

const turn = (sessionId: string) => ({
  sessionId,
  projectRoot: "/p",
  definition: definition(),
  messages: [{ role: "user" as const, text: "hello" }],
  signal: new AbortController().signal,
  onDelta: () => undefined,
  hooks,
});

describe("runtime session lifetime", () => {
  it("releases an idle session after the idle window and reopens it on the next message", async () => {
    vi.useFakeTimers();
    const { open, shutdowns, opened } = fake();
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: open, idleReleaseMs: 1_000 });
    await runtime.complete(turn("ses_1"));
    expect(shutdowns).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(shutdowns).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(shutdowns).toEqual(["s1"]);
    await runtime.complete(turn("ses_1"));
    expect(opened()).toBe(2);
  });

  it("a new turn restarts the idle window", async () => {
    vi.useFakeTimers();
    const { open, shutdowns } = fake();
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: open, idleReleaseMs: 1_000 });
    await runtime.complete(turn("ses_1"));
    await vi.advanceTimersByTimeAsync(800);
    await runtime.complete(turn("ses_1"));
    await vi.advanceTimersByTimeAsync(800);
    expect(shutdowns).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(shutdowns).toEqual(["s1"]);
  });

  it("0 disables the idle timer", async () => {
    vi.useFakeTimers();
    const { open, shutdowns } = fake();
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: open, idleReleaseMs: 0 });
    await runtime.complete(turn("ses_1"));
    await vi.advanceTimersByTimeAsync(10 * 60 * 60_000);
    expect(shutdowns).toEqual([]);
    await runtime.dispose?.();
    expect(shutdowns).toEqual(["s1"]);
  });

  it("dispose releases every open session and cancels their timers", async () => {
    vi.useFakeTimers();
    const { open, shutdowns } = fake();
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: open, idleReleaseMs: 1_000 });
    await runtime.complete(turn("ses_1"));
    await runtime.complete(turn("ses_2"));
    await runtime.dispose?.();
    expect(shutdowns.sort()).toEqual(["s1", "s2"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(shutdowns).toHaveLength(2);
  });
});

describe("host-owned release", () => {
  const fixtures: AgentsFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it("releases a session's runtime when its turn is stopped and when its agent is archived", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("pal"), { source: "console" });
    await service.setEnabled(project, "pal", true, { source: "console" });
    const released: string[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const backend = {
      id: "pi" as const,
      complete: async (input: { signal: AbortSignal }) => {
        started();
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
        return { text: "", toolOutputs: [] };
      },
      release: async (sessionId: string) => void released.push(sessionId),
    };
    const chat = new AgentChatController({ service, backend });
    service.onArchived((_agent, sessionIds) => sessionIds.forEach((id) => void chat.release(id)));
    const opened = await service.openSession(project, "pal", { source: "console" });
    const sending = chat.send({ projectRoot: project, agentId: "pal", sessionId: opened.id, text: "go" });
    await running;
    expect(chat.stop(opened.id)).toBe(true);
    await sending;
    expect(released).toEqual([opened.id]);

    await service.archive(project, "pal");
    expect(released).toEqual([opened.id, opened.id]);
  });
});

describe("Host context", () => {
  it("disposes the runtime on stop and releases an archived agent's sessions", async () => {
    const fixture = await agentsFixture();
    try {
      const released: string[] = [];
      let disposed = 0;
      const backend = {
        id: "pi" as const,
        complete: async () => ({ text: "ok", toolOutputs: [] }),
        release: async (id: string) => void released.push(id),
        dispose: async () => void (disposed += 1),
      };
      const host = createAgentHostContext({ cwd: fixture.project, agentDir: fixture.home, connection: fixture.connection, backend, otlpSink: undefined });
      await host.service.create(fixture.project, agentInput("pal"), { source: "console" });
      await host.service.setEnabled(fixture.project, "pal", true, { source: "console" });
      const session = await host.service.openSession(fixture.project, "pal", { source: "console" });
      await host.service.archive(fixture.project, "pal");
      await vi.waitFor(() => expect(released).toEqual([session.id]));
      await host.stop();
      expect(disposed).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
