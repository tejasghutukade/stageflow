import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { claudeSessionMarkerPath } from "../src/agent/claudeSession.js";
import type { StageRunInput } from "../src/agent/port.js";

type MockToolDef = {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }>;
};

let lastQueryOptions: Record<string, unknown> | undefined;
let lastInterruptSpy: ReturnType<typeof vi.fn> | undefined;
let queryImpl: (options: Record<string, unknown>) => AsyncGenerator<unknown>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    description: string,
    _inputSchema: unknown,
    handler: MockToolDef["handler"],
  ): MockToolDef => ({ name, handler }),
  createSdkMcpServer: (opts: { name: string; tools: MockToolDef[] }) => ({
    type: "sdk",
    name: opts.name,
    instance: { tools: opts.tools },
  }),
  query: vi.fn((params: { options: Record<string, unknown> }) => {
    lastQueryOptions = params.options;
    const generator = queryImpl(params.options) as AsyncGenerator<unknown> & {
      interrupt?: ReturnType<typeof vi.fn>;
    };
    lastInterruptSpy = vi.fn().mockResolvedValue(undefined);
    generator.interrupt = lastInterruptSpy;
    return generator;
  }),
}));

function findTool(options: Record<string, unknown>, name: string): MockToolDef {
  const mcpServers = options.mcpServers as Record<
    string,
    { instance: { tools: MockToolDef[] } }
  >;
  const server = mcpServers.stageflow;
  const found = server.instance.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

function baseInput(overrides: Partial<StageRunInput["stage"]> = {}): StageRunInput {
  return {
    roots: buildStageRoots("/tmp/claude-adapter-test-ws", "review"),
    stage: {
      id: "review",
      system_prompt: "Review the change.",
      model: "anthropic/claude-sonnet-4-5",
      gate_kinds: [],
      ...overrides,
    },
    task: { id: "t1", goal: "review a change" },
    priorEnvelope: null,
  };
}

async function* emptyStream(): AsyncGenerator<unknown> {
  // no messages, no emit call — simulates a turn that ends without emitting
}

function initMessage(
  sessionId: string,
  mcpServers: Array<{ name: string; status: string; error?: string }> = [],
) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: "/tmp",
    tools: [],
    mcp_servers: mcpServers,
    model: "claude-sonnet-4-5",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    apiKeySource: "none",
    claude_code_version: "test",
    uuid: "u-init",
  };
}

function userToolResultMessage(toolCallId: string, content: unknown) {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolCallId, content, is_error: false },
      ],
    },
    parent_tool_use_id: null,
  };
}

async function newAdapter() {
  const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
  return new ClaudeAgentAdapter();
}

function modelUsageResult(cost: number, inputTokens: number, outputTokens: number) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    total_cost_usd: cost,
    modelUsage: {
      "claude-sonnet-4-5": {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: cost,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
  };
}


describe("ClaudeAgentAdapter — preflight", () => {
  it.each([
    { name: "a stage that declares a skill", stage: { skill: "reviewer" }, reason: /skill/ },
    { name: "a non-anthropic model", stage: { model: "openai/gpt-5" }, reason: /anthropic/ },
    {
      name: "a malformed model string with no provider prefix",
      stage: { model: "claude-sonnet-4-5" },
      reason: /must be "anthropic\/<model>"/,
    },
  ])("rejects $name", async ({ stage, reason }) => {
    const adapter = await newAdapter();
    const result = await adapter.runStage(baseInput(stage));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe("ClaudeAgentAdapter — run loop", () => {
  it("passes the derived model and a sealed, custom system prompt to query()", async () => {
    queryImpl = emptyStream;
    const adapter = await newAdapter();
    await adapter.runStage(baseInput());
    expect(lastQueryOptions?.model).toBe("claude-sonnet-4-5");
    expect(lastQueryOptions?.systemPrompt).toEqual({
      type: "custom",
      prompt: "Review the change.",
    });
    expect(lastQueryOptions?.settingSources).toEqual([]);
    expect(lastQueryOptions?.permissionMode).toBe("bypassPermissions");
    expect(lastQueryOptions?.strictMcpConfig).toBe(true);
    expect(lastQueryOptions?.tools).toEqual(["Read", "Write", "Edit", "Bash"]);
    expect(Object.keys((lastQueryOptions?.mcpServers as object) ?? {})).toEqual(["stageflow"]);
    const registered = (
      lastQueryOptions?.mcpServers as Record<string, { instance: { tools: MockToolDef[] } }>
    ).stageflow.instance.tools.map((t) => t.name);
    expect(registered).toEqual(
      expect.arrayContaining(["emit_stage_envelope", "write_stage_artifact"]),
    );
    expect(registered).not.toContain("ask_operator");

    await adapter.runStage({ ...baseInput(), resolvedMcpServers: {} });
    expect(Object.keys((lastQueryOptions?.mcpServers as object) ?? {})).toEqual(["stageflow"]);
    expect(lastQueryOptions?.settingSources).toEqual([]);
    expect(lastQueryOptions?.strictMcpConfig).toBe(true);
  });

  it.each([
    {
      name: "a stdio github server",
      snapshot: { github: { command: "npx", args: ["-y", "pkg"] } } as Record<
        string,
        Record<string, unknown>
      >,
      expected: { github: { command: "npx", args: ["-y", "pkg"], alwaysLoad: true } },
    },
    {
      name: "two stdio servers in snapshot order",
      snapshot: {
        github: { command: "npx", args: ["-y", "pkg"] },
        slack: { command: "npx", args: ["-y", "slack"] },
      } as Record<string, Record<string, unknown>>,
      expected: {
        github: { command: "npx", args: ["-y", "pkg"], alwaysLoad: true },
        slack: { command: "npx", args: ["-y", "slack"], alwaysLoad: true },
      },
    },
    {
      name: "an HTTP server",
      snapshot: { remote: { type: "http", url: "https://example.invalid/mcp" } } as Record<
        string,
        Record<string, unknown>
      >,
      expected: {
        remote: { type: "http", url: "https://example.invalid/mcp", alwaysLoad: true },
      },
    },
  ])("merges $name beside stageflow with alwaysLoad, without mutating the input", async ({ snapshot, expected }) => {
    queryImpl = emptyStream;
    const adapter = await newAdapter();
    await adapter.runStage({ ...baseInput(), resolvedMcpServers: snapshot });
    const mcpServers = lastQueryOptions?.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(mcpServers)).toEqual(["stageflow", ...Object.keys(expected)]);
    for (const [name, entry] of Object.entries(expected)) {
      expect(mcpServers[name]).toMatchObject(entry);
      expect(snapshot[name]).not.toHaveProperty("alwaysLoad");
    }
    expect(lastQueryOptions?.settingSources).toEqual([]);
    expect(lastQueryOptions?.strictMcpConfig).toBe(true);
  });


  it("keeps query() cwd as the agent workspace and passes stamped per-server cwd", async () => {
    queryImpl = emptyStream;
    const adapter = await newAdapter();
    const input = baseInput();
    const projectRoot = "/factory/catalog-root";
    await adapter.runStage({
      ...input,
      resolvedMcpServers: {
        echo: {
          command: "npx",
          args: [path.resolve(projectRoot, "examples/stage-mcp/echo-mcp.mjs")],
          cwd: projectRoot,
        },
      },
    });
    const mcpServers = lastQueryOptions?.mcpServers as Record<string, Record<string, unknown>>;
    expect(lastQueryOptions?.cwd).toBe(input.roots.cwd);
    expect(lastQueryOptions?.cwd).not.toBe(projectRoot);
    expect(mcpServers.echo).toMatchObject({
      command: "npx",
      args: [path.resolve(projectRoot, "examples/stage-mcp/echo-mcp.mjs")],
      cwd: projectRoot,
      alwaysLoad: true,
    });
  });

  it("returns ok:true when emit_stage_envelope is called with status=success", async () => {
    queryImpl = async function* (options) {
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler(
        { status: "success", summary: "done", artifacts: [] },
        undefined,
      );
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("done");
  });

  it.each([
    { name: "the result message directly follows the emit", userFrames: 0, cost: 0.0042, input: 120, output: 30 },
    {
      name: "the tool_result 'user' frame (the real SDK order) precedes 'result'",
      userFrames: 1,
      cost: 0.0099,
      input: 200,
      output: 60,
    },
    {
      name: "an extra trailing 'user' frame lands between the tool-result and 'result'",
      userFrames: 2,
      cost: 0.0055,
      input: 90,
      output: 20,
    },
  ])("captures cost/tokens from modelUsage onto the completed result when $name", async ({ userFrames, cost, input, output }) => {
    // Real query() sequence: emit_stage_envelope's tool_result lands on a
    // "user" message BEFORE the turn-summary "result" message, and after
    // interrupt() the stream can emit further "user" frames. The adapter must
    // keep draining (within budget) until "result" so usage is not lost.
    queryImpl = async function* (options) {
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler({ status: "success", summary: "done", artifacts: [] }, undefined);
      for (let i = 0; i < userFrames; i++) {
        yield userToolResultMessage(`tool-${i + 1}`, "ok");
      }
      yield modelUsageResult(cost, input, output);
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(true);
    expect(result.usage?.costUsd).toBeCloseTo(cost, 10);
    expect(result.usage?.models["claude-sonnet-4-5"]).toMatchObject({
      inputTokens: input,
      outputTokens: output,
      costUsd: cost,
    });
  });


  it("returns ok:false status:failure envelope when emit_stage_envelope is called with status=failure", async () => {
    queryImpl = async function* (options) {
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler(
        { status: "failure", summary: "could not complete", artifacts: [] },
        undefined,
      );
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("status: failure");
      expect(result.envelope?.summary).toBe("could not complete");
    }
  });

  it("returns ok:false when the turn ends without calling emit_stage_envelope", async () => {
    queryImpl = async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done talking" };
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing emit_stage_envelope");
  });

  it.each([
    { name: "no snapshot", snapshot: undefined },
    { name: "a snapshot", snapshot: { github: { command: "npx", args: ["-y", "pkg"] } } },
  ])("surfaces a thrown query() error as ok:false with the error message ($name), not as connect_failed", async ({ snapshot }) => {
    queryImpl = async function* () {
      throw new Error("subprocess spawn failed");
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage({ ...baseInput(), resolvedMcpServers: snapshot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("subprocess spawn failed");
      expect(result.reason).not.toMatch(/connect_failed/i);
    }
  });


  it("openStage never waits — completes directly via next()", async () => {
    queryImpl = async function* (options) {
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler({ status: "success", summary: "ok", artifacts: [] }, undefined);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const handle = adapter.openStage(baseInput());
    const event = await handle.next();
    expect(event.status).toBe("completed");
    await handle.close();
  });

  it("emits activity events via onActivity for tool calls and messages", async () => {
    queryImpl = async function* (options) {
      const emitTool = findTool(options, "emit_stage_envelope");
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking at the diff." },
            { type: "tool_use", id: "c1", name: "emit_stage_envelope", input: {} },
          ],
        },
        parent_tool_use_id: null,
      };
      const toolResult = await emitTool.handler(
        { status: "success", summary: "ok", artifacts: [] },
        undefined,
      );
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: toolResult.content,
              is_error: toolResult.isError ?? false,
            },
          ],
        },
        parent_tool_use_id: null,
      };
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const events: string[] = [];
    await adapter.runStage({
      ...baseInput(),
      onActivity: (event) => events.push(event.event),
    });
    expect(events).toEqual([
      "agent_start",
      "turn_start",
      "message",
      "tool_start",
      "tool_end",
      "agent_end",
    ]);
  });

  it("emits tool_start/tool_end for mcp__github__list_issues via onActivity", async () => {
    queryImpl = async function* (options) {
      const emitTool = findTool(options, "emit_stage_envelope");
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "mcp-1",
              name: "mcp__github__list_issues",
              input: { owner: "acme", repo: "app" },
            },
          ],
        },
        parent_tool_use_id: null,
      };
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "mcp-1",
              content: '[{"number":1}]',
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
      };
      await emitTool.handler({ status: "success", summary: "ok", artifacts: [] }, undefined);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const events: Array<{ event: string; toolName?: string }> = [];
    await adapter.runStage({
      ...baseInput(),
      onActivity: (event) => {
        events.push(
          event.event === "tool_start" || event.event === "tool_end"
            ? { event: event.event, toolName: event.toolName }
            : { event: event.event },
        );
      },
    });
    expect(events).toEqual([
      { event: "agent_start" },
      { event: "turn_start" },
      { event: "tool_start", toolName: "mcp__github__list_issues" },
      { event: "tool_end", toolName: "mcp__github__list_issues" },
      { event: "agent_end" },
    ]);
  });
});

describe("ClaudeAgentAdapter — MCP connect-fail", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "sf-claude-adapter-mcp-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "failed init status for a passed stdio server",
      status: "failed",
      server: { github: { command: "npx", args: ["-y", "pkg"] } } as Record<string, Record<string, unknown>>,
      serverName: "github",
    },
    {
      name: "needs-auth for a passed HTTP server",
      status: "needs-auth",
      server: { remote: { type: "http", url: "https://example.invalid/mcp" } } as Record<
        string,
        Record<string, unknown>
      >,
      serverName: "remote",
    },
    {
      name: "pending init status for a passed server",
      status: "pending",
      server: { github: { command: "npx", args: ["-y", "pkg"] } } as Record<string, Record<string, unknown>>,
      serverName: "github",
    },
  ])("$name fails the stage as connect_failed and interrupts before emit can win", async ({ status, server, serverName }) => {
    let emitHandlerRan = false;
    queryImpl = async function* (options) {
      yield initMessage(`session-${status}`, [{ name: serverName, status }]);
      const emitTool = findTool(options, "emit_stage_envelope");
      emitHandlerRan = true;
      await emitTool.handler({ status: "success", summary: "should not win", artifacts: [] }, undefined);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage({ ...baseInput(), resolvedMcpServers: server });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/connect_failed|failed to connect/i);
      expect(result.reason).toContain(serverName);
    }
    expect(lastInterruptSpy).toHaveBeenCalled();
    expect(emitHandlerRan).toBe(false);
  });


  it("continues the turn when a passed server is connected and emit still succeeds", async () => {
    queryImpl = async function* (options) {
      yield initMessage("session-connected", [{ name: "github", status: "connected" }]);
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler({ status: "success", summary: "done with github", artifacts: [] }, undefined);
      yield userToolResultMessage("c1", "ok");
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: { github: { command: "npx", args: ["-y", "pkg"] } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("done with github");
  });

  it.each([
    { name: "no snapshot", snapshot: undefined },
    { name: "an empty resolvedMcpServers snapshot", snapshot: {} },
  ])("init mcp_servers: [] with $name does not connect_fail; missing emit still applies", async ({ snapshot }) => {
    queryImpl = async function* () {
      yield initMessage("session-empty");
      yield { type: "result", subtype: "success", is_error: false, result: "done talking" };
    };
    const adapter = await newAdapter();
    const result = await adapter.runStage({ ...baseInput(), resolvedMcpServers: snapshot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing emit_stage_envelope");
      expect(result.reason).not.toMatch(/connect_failed/i);
    }
  });


  it("resume turn with a failed passed server is connect_failed and does not complete the parked prompt as success", async () => {
    queryImpl = async function* (options) {
      if (options.resume !== undefined) {
        yield initMessage("session-resume-connect-fail", [{ name: "github", status: "failed" }]);
        const emitTool = findTool(options, "emit_stage_envelope");
        await emitTool.handler(
          { status: "success", summary: "should not complete", artifacts: [] },
          undefined,
        );
        yield { type: "result", subtype: "success", is_error: false, result: "ok" };
        return;
      }
      yield initMessage("session-resume-connect-fail", [{ name: "github", status: "connected" }]);
      const askTool = findTool(options, "ask_operator");
      const result = await askTool.handler(
        { kind: "free_text", message: "Which env?", id: "q1" },
        undefined,
      );
      yield userToolResultMessage("c1", result.content);
    };
    const adapter = await newAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
      roots: buildStageRoots(workspaceDir, "review"),
      resolvedMcpServers: { github: { command: "npx", args: ["-y", "pkg"] } },
    };
    const handle = adapter.openStage(input);
    const waitEvent = await handle.next();
    expect(waitEvent.status).toBe("waiting_for_input");

    handle.deliverAnswer({ promptId: "q1", kind: "free_text", text: "staging" });
    const doneEvent = await handle.next();
    expect(doneEvent.status).toBe("completed");
    if (doneEvent.status === "completed") {
      expect(doneEvent.result.ok).toBe(false);
      if (!doneEvent.result.ok) {
        expect(doneEvent.result.reason).toMatch(/connect_failed|failed to connect/i);
        expect(doneEvent.result.reason).toMatch(/github/);
      }
    }
    expect(lastInterruptSpy).toHaveBeenCalled();
  });
});

describe("ClaudeAgentAdapter — HITL (ask_operator)", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "sf-claude-adapter-hitl-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });
  it.each([
    { name: "an explicit empty array", gate_kinds: [] as string[] },
    { name: "omitted", gate_kinds: undefined },
  ])("does not register ask_operator when gate_kinds is $name", async ({ gate_kinds }) => {
    queryImpl = async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    await adapter.runStage(baseInput({ gate_kinds: gate_kinds as [] }));
    expect(() => findTool(lastQueryOptions!, "ask_operator")).toThrow(/not registered/);
  });


  it("openStage → next() returns waiting_for_input when the model calls ask_operator, and calls interrupt()", async () => {
    queryImpl = async function* (options) {
      yield initMessage("session-abc");
      const askTool = findTool(options, "ask_operator");
      const result = await askTool.handler(
        { kind: "free_text", message: "Which env?" },
        undefined,
      );
      yield userToolResultMessage("c1", result.content);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const adapter = await newAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
      roots: buildStageRoots(workspaceDir, "review"),
    };

    const handle = adapter.openStage(input);
    const event = await handle.next();
    expect(event.status).toBe("waiting_for_input");
    if (event.status === "waiting_for_input") {
      expect(event.request).toMatchObject({ kind: "free_text", message: "Which env?" });
    }
    expect(lastInterruptSpy).toHaveBeenCalled();
    await handle.close({ park: true });
  });


  it("deliverAnswer + next() resumes the same session and completes on emit_stage_envelope", async () => {
    let resumeSeen: string | undefined;
    queryImpl = async function* (options) {
      if (options.resume !== undefined) {
        resumeSeen = options.resume as string;
        const emitTool = findTool(options, "emit_stage_envelope");
        await emitTool.handler({ status: "success", summary: "resumed ok", artifacts: [] }, undefined);
        yield { type: "result", subtype: "success", is_error: false, result: "ok" };
        return;
      }
      yield initMessage("session-resume-1");
      const askTool = findTool(options, "ask_operator");
      const result = await askTool.handler(
        { kind: "free_text", message: "Which env?", id: "q1" },
        undefined,
      );
      yield userToolResultMessage("c1", result.content);
    };
    const adapter = await newAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
      roots: buildStageRoots(workspaceDir, "review"),
    };
    const handle = adapter.openStage(input);
    const waitEvent = await handle.next();
    expect(waitEvent.status).toBe("waiting_for_input");

    handle.deliverAnswer({ promptId: "q1", kind: "free_text", text: "staging" });
    const doneEvent = await handle.next();
    expect(doneEvent.status).toBe("completed");
    if (doneEvent.status === "completed") {
      expect(doneEvent.result.ok).toBe(true);
    }
    expect(resumeSeen).toBe("session-resume-1");
  });

  it("resume query() merges the snapshot and keeps isolation flags", async () => {
    const snapshot = { github: { command: "npx", args: ["-y", "pkg"] } };
    queryImpl = async function* (options) {
      if (options.resume !== undefined) {
        yield initMessage("session-resume-mcp", [{ name: "github", status: "connected" }]);
        const emitTool = findTool(options, "emit_stage_envelope");
        await emitTool.handler({ status: "success", summary: "resumed with mcp", artifacts: [] }, undefined);
        yield { type: "result", subtype: "success", is_error: false, result: "ok" };
        return;
      }
      yield initMessage("session-resume-mcp", [{ name: "github", status: "connected" }]);
      const askTool = findTool(options, "ask_operator");
      const result = await askTool.handler(
        { kind: "free_text", message: "Which env?", id: "q1" },
        undefined,
      );
      yield userToolResultMessage("c1", result.content);
    };
    const adapter = await newAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
      roots: buildStageRoots(workspaceDir, "review"),
      resolvedMcpServers: snapshot,
    };
    const handle = adapter.openStage(input);
    const waitEvent = await handle.next();
    expect(waitEvent.status).toBe("waiting_for_input");

    handle.deliverAnswer({ promptId: "q1", kind: "free_text", text: "staging" });
    const doneEvent = await handle.next();
    expect(doneEvent.status).toBe("completed");
    if (doneEvent.status === "completed") {
      expect(doneEvent.result.ok).toBe(true);
    }

    const mcpServers = lastQueryOptions?.mcpServers as Record<string, Record<string, unknown>>;
    expect(lastQueryOptions?.resume).toBe("session-resume-mcp");
    expect(lastQueryOptions?.strictMcpConfig).toBe(true);
    expect(lastQueryOptions?.settingSources).toEqual([]);
    expect(Object.keys(mcpServers)).toEqual(["stageflow", "github"]);
    expect(mcpServers.github.alwaysLoad).toBe(true);
    expect(snapshot.github).not.toHaveProperty("alwaysLoad");
  });

  it("resumes correctly from a fresh handle (new process) after park, via the persisted marker", async () => {
    queryImpl = async function* (options) {
      yield initMessage("session-cross-process");
      const askTool = findTool(options, "ask_operator");
      const result = await askTool.handler(
        { kind: "confirm", message: "Deploy now?", id: "q1" },
        undefined,
      );
      yield userToolResultMessage("c1", result.content);
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const firstAdapter = new ClaudeAgentAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
      roots: buildStageRoots(workspaceDir, "review"),
    };
    const firstHandle = firstAdapter.openStage(input);
    const waitEvent = await firstHandle.next();
    expect(waitEvent.status).toBe("waiting_for_input");
    await firstHandle.close({ park: true });

    // Simulate a brand-new process: fresh adapter, fresh handle, same input.
    queryImpl = async function* (options) {
      expect(options.resume).toBe("session-cross-process");
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler({ status: "success", summary: "deployed", artifacts: [] }, undefined);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const secondAdapter = new ClaudeAgentAdapter();
    const secondHandle = secondAdapter.openStage(input);
    const rediscovered = await secondHandle.next();
    expect(rediscovered.status).toBe("waiting_for_input");
    if (rediscovered.status === "waiting_for_input") {
      expect(rediscovered.request).toMatchObject({ kind: "confirm", message: "Deploy now?" });
    }

    secondHandle.deliverAnswer({ promptId: "q1", kind: "confirm", decision: "accept" });
    const finalEvent = await secondHandle.next();
    expect(finalEvent.status).toBe("completed");
    if (finalEvent.status === "completed") {
      expect(finalEvent.result.ok).toBe(true);
    }
  });

  it("deliverAnswer with a mismatched answer kind fails closed", async () => {
    queryImpl = async function* (options) {
      yield initMessage("session-mismatch");
      const askTool = findTool(options, "ask_operator");
      const result = await askTool.handler(
        { kind: "free_text", message: "Which env?", id: "q1" },
        undefined,
      );
      yield userToolResultMessage("c1", result.content);
    };
    const adapter = await newAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
      roots: buildStageRoots(workspaceDir, "review"),
    };
    const handle = adapter.openStage(input);
    await handle.next();
    handle.deliverAnswer({ promptId: "q1", kind: "confirm", decision: "accept" });
    const event = await handle.next();
    expect(event.status).toBe("completed");
    if (event.status === "completed") {
      expect(event.result.ok).toBe(false);
      if (!event.result.ok) expect(event.result.reason).toMatch(/invalid operator answer/);
    }
  });
});

describe("ClaudeAgentAdapter — never-let-it-go-dangling regression guard", () => {
  // Phase 0's spike found that a *blocking* ask_operator handler (Pi's own
  // mechanism) is exactly the shape that produces a dangling tool call once
  // a process dies — the orphaned `claude` subprocess self-corrupts the
  // pending call ~20s later with no human input. Phase 3's design avoids
  // this by construction: the handler must never await anything that only
  // resolves once an operator answers. This test fails if that ever
  // regresses — e.g. someone "fixes" ask_operator by reusing
  // tools/askOperator.ts's own blocking `execute` (which awaits
  // `requestWait`) instead of the adapter's non-blocking wrapper.
  it("ask_operator's handler resolves immediately — never awaits an external answer", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const capture: { prompt?: unknown } = {};
    const server = buildStageflowMcpServer({
      capture: {},
      writeStageArtifact: { runWorkspaceDir: "/tmp/x", stageId: "s", attempt: 1 },
      askOperator: { capture },
    }) as unknown as { instance: { tools: MockToolDef[] } };
    const askTool = server.instance.tools.find((t) => t.name === "ask_operator");
    if (!askTool) throw new Error("ask_operator tool not registered");

    const TIMEOUT = Symbol("timeout");
    const race = await Promise.race([
      askTool.handler({ kind: "free_text", message: "Which env?" }, undefined),
      new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 50)),
    ]);

    expect(race).not.toBe(TIMEOUT);
    expect(capture.prompt).toMatchObject({ kind: "free_text", message: "Which env?" });
  });

  it("close({park: true}) after waiting calls neither interrupt() again nor query() again", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-claude-adapter-guard-"));
    try {
      queryImpl = async function* (options) {
        yield initMessage("session-guard");
        const askTool = findTool(options, "ask_operator");
        const result = await askTool.handler({ kind: "confirm", message: "Proceed?" }, undefined);
        yield userToolResultMessage("c1", result.content);
      };
      const queryMock = (await import("@anthropic-ai/claude-agent-sdk")).query as unknown as {
        mock: { calls: unknown[] };
      };
      const callsBefore = queryMock.mock.calls.length;

      const adapter = await newAdapter();
      const input: StageRunInput = {
        ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
        roots: buildStageRoots(dir, "review"),
      };
      const handle = adapter.openStage(input);
      await handle.next();
      const interruptCallsAtWait = lastInterruptSpy?.mock.calls.length ?? 0;

      await handle.close({ park: true });

      expect(queryMock.mock.calls.length).toBe(callsBefore + 1);
      expect(lastInterruptSpy?.mock.calls.length ?? 0).toBe(interruptCallsAtWait);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears the session marker when preflight fails on resume, not just on an invalid answer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-claude-adapter-guard-"));
    try {
      queryImpl = async function* (options) {
        yield initMessage("session-preflight-fail");
        const askTool = findTool(options, "ask_operator");
        const result = await askTool.handler(
          { kind: "confirm", message: "Proceed?", id: "q1" },
          undefined,
        );
        yield userToolResultMessage("c1", result.content);
      };
      const adapter = await newAdapter();
      const input: StageRunInput = {
        ...baseInput({ gate_kinds: ["free_text", "confirm"] }),
        roots: buildStageRoots(dir, "review"),
      };
      const markerPath = claudeSessionMarkerPath(input);

      const handle = adapter.openStage(input);
      const waitEvent = await handle.next();
      expect(waitEvent.status).toBe("waiting_for_input");
      expect(existsSync(markerPath)).toBe(true);

      // Simulate preflight becoming invalid between the wait and the resume
      // (today only reachable this way — model/skill are otherwise static
      // across a handle's lifetime).
      input.stage.model = "openai/gpt-5";

      handle.deliverAnswer({ promptId: "q1", kind: "confirm", decision: "accept" });
      const doneEvent = await handle.next();
      expect(doneEvent.status).toBe("completed");
      if (doneEvent.status === "completed") {
        expect(doneEvent.result.ok).toBe(false);
      }
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeAgentAdapter — message-ordering invariant", () => {
  // runTurn's completion check fires on `message.type === "user"` once
  // emit_stage_envelope's (or ask_operator's) tool_result has landed. It
  // never inspected *which* tool_result that was, or whether it shares the
  // message with an unrelated tool's result — this test pins that down so
  // a future rewrite of the loop can't accidentally start caring about
  // position within the message.
  it("detects emit_stage_envelope's tool_result even sharing a message with an unrelated tool_result first", async () => {
    queryImpl = async function* (options) {
      const readToolCallId = "unrelated-1";
      const emitToolCallId = "emit-1";
      const emitTool = findTool(options, "emit_stage_envelope");

      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: readToolCallId, name: "Read", input: { path: "x.ts" } },
            {
              type: "tool_use",
              id: emitToolCallId,
              name: "emit_stage_envelope",
              input: { status: "success", summary: "ok", artifacts: [] },
            },
          ],
        },
        parent_tool_use_id: null,
      };

      const emitResult = await emitTool.handler(
        { status: "success", summary: "ok", artifacts: [] },
        undefined,
      );

      // The unrelated tool's result lands FIRST in the same user message.
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: readToolCallId,
              content: "file contents here",
              is_error: false,
            },
            {
              type: "tool_result",
              tool_use_id: emitToolCallId,
              content: emitResult.content,
              is_error: emitResult.isError ?? false,
            },
          ],
        },
        parent_tool_use_id: null,
      };
    };

    const adapter = await newAdapter();
    const result = await adapter.runStage(baseInput());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("ok");
  });
});
