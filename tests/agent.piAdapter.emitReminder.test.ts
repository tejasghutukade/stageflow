import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";

const piSdkMocks = vi.hoisted(() => ({ createAgentSession: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: piSdkMocks.createAgentSession };
});

type Tool = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };

/**
 * A scripted session: `turns[i]` runs on the i-th prompt with the stage's tools and the
 * message list. Every prompt text is recorded.
 */
function scriptSession(turns: Array<(tools: Tool[], messages: unknown[]) => Promise<void> | void>) {
  const prompts: string[] = [];
  piSdkMocks.createAgentSession.mockImplementation(async (options: { customTools?: Tool[] }) => {
    const messages: unknown[] = [];
    const tools = options?.customTools ?? [];
    return {
      session: {
        bindExtensions: async () => {},
        setModel: async () => {},
        setThinkingLevel: () => {},
        async prompt(text: string) {
          prompts.push(text);
          messages.push({ role: "user", content: text });
          const turn = turns.shift();
          if (turn) await turn(tools, messages);
          else messages.push({ role: "assistant", stopReason: "stop" });
        },
        get messages() {
          return messages;
        },
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        agent: { state: { messages }, continue: async () => {} },
      },
    };
  });
  return prompts;
}

const emit = (tools: Tool[], params: unknown) =>
  tools.find((t) => t.name === "emit_stage_envelope")!.execute("emit-1", params);

const tempDirs: string[] = [];

async function input(): Promise<StageRunInput> {
  const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-reminder-"));
  tempDirs.push(runWs);
  return {
    roots: buildStageRoots(runWs, "clarify"),
    stage: { id: "clarify", system_prompt: "x", model: "anthropic/claude-sonnet-4-5" },
    task: { id: "t", goal: "g" },
    priorEnvelope: null,
  };
}

beforeEach(() => piSdkMocks.createAgentSession.mockReset());
afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Pi stage: turn ends without an envelope", () => {
  it("sends a reminder and succeeds when the agent then emits", async () => {
    const prompts = scriptSession([
      (_tools, messages) => {
        messages.push({ role: "assistant", stopReason: "stop" });
      },
      async (tools, messages) => {
        await emit(tools, { status: "success", summary: "done", artifacts: [] });
        messages.push({ role: "assistant", stopReason: "stop" });
      },
    ]);
    const result = await new PiAgentAdapter().runStage(await input());
    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Reminder 1 of 2");
  });

  it("fails as missing emit after two unanswered reminders", async () => {
    const prompts = scriptSession([]);
    const result = await new PiAgentAdapter().runStage(await input());
    expect(result).toMatchObject({ ok: false, reason: "missing emit_stage_envelope" });
    expect(prompts).toHaveLength(3);
  });

  it("reports the provider error instead of a missing emit, without reminders", async () => {
    const prompts = scriptSession([
      (_tools, messages) => {
        messages.push({
          role: "assistant",
          stopReason: "error",
          errorMessage: "Cursor SDK runs require a Cursor SDK API key.",
        });
      },
    ]);
    const result = await new PiAgentAdapter().runStage(await input());
    expect(result).toMatchObject({
      ok: false,
      reason: "provider error: Cursor SDK runs require a Cursor SDK API key.",
    });
    expect(prompts).toHaveLength(1);
  });

  it("does not remind after an agent-declared failure", async () => {
    const prompts = scriptSession([
      async (tools, messages) => {
        await emit(tools, { status: "failure", summary: "LinkedIn showed a checkpoint", artifacts: [] });
        messages.push({ role: "assistant", stopReason: "stop" });
      },
    ]);
    const result = await new PiAgentAdapter().runStage(await input());
    expect(result).toMatchObject({ ok: false, reason: "status: failure" });
    expect(prompts).toHaveLength(1);
  });
});
