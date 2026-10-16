import { describe, expect, it, vi } from "vitest";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { createPiAgentRuntime, type OpenSessionInput } from "../src/agents/runtime/piRuntime.js";
import { grantIdForPiTool, type TurnHooks } from "../src/agents/runtime/types.js";

function definition(overrides: Record<string, unknown> = {}) {
  const parsed = parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help.", enabled: true, ...overrides });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

function hooks(overrides: Partial<TurnHooks> = {}): TurnHooks & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    gate: async () => ({ allow: true }),
    toolStarted: (c) => void events.push(`start ${c.tool}`),
    toolFinished: (c, r) => void events.push(`end ${c.tool} ${r.ok} ${r.output}`),
    modelFinished: (i) => void events.push(`model ${i.inputTokens}/${i.outputTokens}`),
    delegate: async () => "sub reply",
    ...overrides,
  };
}

/** A fake Pi session whose `prompt` plays a scripted sequence of Pi events. */
function fakeOpen(script: (emit: (event: unknown) => void, input: OpenSessionInput) => Promise<void>) {
  const opened: OpenSessionInput[] = [];
  const prompts: string[] = [];
  const open = async (input: OpenSessionInput) => {
    opened.push(input);
    const listeners = new Set<(event: unknown) => void>();
    return {
      toolNames: input.toolNames,
      shutdown: vi.fn(async () => undefined),
      session: {
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        prompt: async (text: string) => {
          prompts.push(text);
          await script((event) => listeners.forEach((l) => l(event)), input);
        },
        dispose: () => undefined,
        abort: async () => undefined,
      },
    } as never;
  };
  return { open, opened, prompts };
}

const assistantEnd = { type: "message_end", message: { role: "assistant", model: "m", content: [{ type: "text", text: "hi" }], usage: { input: 7, output: 3, cost: { total: 0.002 } } } };

describe("Pi agent runtime", () => {
  it("fails a turn when the model goes quiet, but not while waiting on an approval", async () => {
    vi.stubEnv("STAGEFLOW_AGENT_STALL_SECONDS", "0.1");
    try {
      const sessionFor = (onPrompt: (emit: (event: unknown) => void, abortSignal: Promise<void>, opened: OpenSessionInput) => Promise<void>) => async (input: OpenSessionInput) => {
        let release: () => void = () => undefined;
        const aborted = new Promise<void>((resolve) => (release = resolve));
        const listeners = new Set<(event: unknown) => void>();
        return {
          toolNames: input.toolNames,
          shutdown: vi.fn(async () => undefined),
          session: {
            subscribe: (listener: (event: unknown) => void) => (listeners.add(listener), () => listeners.delete(listener)),
            prompt: async () => onPrompt((event) => listeners.forEach((l) => l(event)), aborted, input),
            dispose: () => undefined,
            abort: async () => release(),
          },
        } as never;
      };
      const run = (open: ReturnType<typeof sessionFor>, h = hooks()) =>
        createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: open }).complete({
          sessionId: "s", projectRoot: "/p", definition: definition(), messages: [{ role: "user", text: "x" }],
          signal: new AbortController().signal, onDelta: () => undefined, hooks: h,
        });
      await expect(run(sessionFor(async (_emit, aborted) => aborted))).rejects.toMatchObject({ code: "agent.model_timeout" });
      // A person taking longer than the stall window to approve a tool is not a stall.
      await expect(
        run(
          sessionFor(async (emit, _aborted, opened) => {
            await opened.gate({ toolCallId: "c1", toolName: "read", input: { path: "a" } });
            emit(assistantEnd);
          }),
          hooks({ gate: async () => (await new Promise((resolve) => setTimeout(resolve, 400)), { allow: true }) }),
        ),
      ).resolves.toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses Cursor models, whose native tools bypass the grants", async () => {
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a" });
    await expect(
      runtime.complete({ sessionId: "s", projectRoot: "/p", definition: definition({ model: { id: "cursor/auto" } }), messages: [{ role: "user", text: "x" }], signal: new AbortController().signal, onDelta: () => undefined, hooks: hooks() }),
    ).rejects.toMatchObject({ code: "agent.backend_unavailable" });
  });

  it("exposes only the granted builtin tool groups", async () => {
    const fake = fakeOpen(async () => undefined);
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: fake.open });
    await runtime.complete({ sessionId: "s", projectRoot: "/p", definition: definition({ tools: { builtin: ["read", "write"] } }), messages: [{ role: "user", text: "x" }], signal: new AbortController().signal, onDelta: () => undefined, hooks: hooks() });
    expect(fake.opened[0]!.toolNames.sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
    expect(fake.opened[0]!.systemPrompt).toContain("Help.");
  });

  it("maps Pi events to text, usage, tool hooks and tool outputs", async () => {
    const h = hooks();
    const fake = fakeOpen(async (emit) => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } });
      emit({ type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "body" }] }, isError: false });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
      emit(assistantEnd);
    });
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: fake.open });
    const deltas: string[] = [];
    const result = await runtime.complete({ sessionId: "s", projectRoot: "/p", definition: definition({ tools: { builtin: ["read"] } }), messages: [{ role: "user", text: "x" }], signal: new AbortController().signal, onDelta: (t) => deltas.push(t), hooks: h });
    expect(result).toMatchObject({ text: "hi", toolOutputs: ["body"], usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.002 } });
    expect(deltas).toEqual(["hi"]);
    expect(h.events).toEqual(["start read", "end read true body", "model 7/3"]);
  });

  it("reuses one model session per conversation and replays prior messages only when starting fresh", async () => {
    const fake = fakeOpen(async () => undefined);
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: fake.open });
    const base = { sessionId: "s", projectRoot: "/p", definition: definition(), signal: new AbortController().signal, onDelta: () => undefined, hooks: hooks() };
    await runtime.complete({ ...base, messages: [{ role: "user", text: "one" }, { role: "assistant", text: "r1" }, { role: "user", text: "two" }] });
    await runtime.complete({ ...base, messages: [{ role: "user", text: "three" }] });
    expect(fake.opened).toHaveLength(1);
    expect(fake.prompts[0]).toContain("user: one");
    expect(fake.prompts[0]).toContain("assistant: r1");
    expect(fake.prompts[1]).toBe("three");
  });

  it("blocks writes to agent definitions and Stageflow state, and defers other calls to the turn gate", async () => {
    const gate = vi.fn(async () => ({ allow: false as const, reason: "no" }));
    const h = hooks({ gate });
    let blocked: unknown;
    let deferred: unknown;
    const fake = fakeOpen(async (_emit, input) => {
      blocked = await input.gate({ toolCallId: "1", toolName: "write", input: { path: "/p/agents/x.agent.yaml" } });
      deferred = await input.gate({ toolCallId: "2", toolName: "write", input: { path: "/p/notes.md" } });
    });
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: fake.open });
    await runtime.complete({ sessionId: "s", projectRoot: "/p", definition: definition({ tools: { builtin: ["write"] } }), messages: [{ role: "user", text: "x" }], signal: new AbortController().signal, onDelta: () => undefined, hooks: h });
    expect(blocked).toMatchObject({ block: true, reason: expect.stringMatching(/cannot be written/) });
    expect(deferred).toMatchObject({ block: true, reason: "no" });
    expect(gate).toHaveBeenCalledOnce();
  });

  it("refuses the claude backend and sandbox execution without a runner", async () => {
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: fakeOpen(async () => undefined).open });
    const call = (def: ReturnType<typeof definition>) => runtime.complete({ sessionId: Math.random().toString(), projectRoot: "/p", definition: def, messages: [{ role: "user", text: "x" }], signal: new AbortController().signal, onDelta: () => undefined, hooks: hooks() });
    await expect(call(definition({ model: { backend: "claude" } }))).rejects.toMatchObject({ code: "agent.backend_unavailable" });
    await expect(call(definition({ execution: "sandbox" }))).rejects.toMatchObject({ code: "agent.sandbox_unavailable" });
  });

  it("judges with a tool-less session", async () => {
    const fake = fakeOpen(async (emit) => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "0.7" } }));
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: fake.open });
    const out = await runtime.judge!({ projectRoot: "/p", definition: definition({ tools: { builtin: ["shell"] } }), prompt: "rate", signal: new AbortController().signal });
    expect(out).toBe("0.7");
    expect(fake.opened[0]!.toolNames).toEqual([]);
  });
});

describe("grant ids", () => {
  it("maps Pi tool names back to grant ids", () => {
    expect(grantIdForPiTool("read", [], [])).toBe("read");
    expect(grantIdForPiTool("web_fetch_page", ["web"], [])).toBe("web.fetch_page");
    expect(grantIdForPiTool("web_x_get", ["web", "web_x"], [])).toBe("web_x.get");
    expect(grantIdForPiTool("agent_worker", [], ["worker"])).toBe("agent:worker");
  });
});
