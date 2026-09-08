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

describe("ClaudeAgentAdapter — preflight", () => {
  it("rejects a stage that declares a skill", async () => {
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input = baseInput({ skill: "reviewer" });
    const result = await adapter.runStage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/skill/);
  });

  it("rejects a non-anthropic model", async () => {
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input = baseInput({ model: "openai/gpt-5" });
    const result = await adapter.runStage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/anthropic/);
  });

  it("rejects a malformed model string with no provider prefix", async () => {
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input = baseInput({ model: "claude-sonnet-4-5" });
    const result = await adapter.runStage(input);
    expect(result.ok).toBe(false);
  });
});

describe("ClaudeAgentAdapter — run loop", () => {
  it("passes the derived model and a sealed, custom system prompt to query()", async () => {
    queryImpl = emptyStream;
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
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
  });

  it("empty resolvedMcpServers snapshot still yields only the in-process stageflow server", async () => {
    queryImpl = emptyStream;
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    await adapter.runStage({ ...baseInput(), resolvedMcpServers: {} });
    expect(Object.keys((lastQueryOptions?.mcpServers as object) ?? {})).toEqual(["stageflow"]);
    expect(lastQueryOptions?.settingSources).toEqual([]);
    expect(lastQueryOptions?.strictMcpConfig).toBe(true);
  });

  it("merges a github snapshot beside stageflow without mutating the input", async () => {
    queryImpl = emptyStream;
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const snapshot = { github: { command: "npx", args: ["-y", "pkg"] } };
    await adapter.runStage({ ...baseInput(), resolvedMcpServers: snapshot });
    const mcpServers = lastQueryOptions?.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(mcpServers)).toEqual(["stageflow", "github"]);
    expect(mcpServers.github.alwaysLoad).toBe(true);
    expect(mcpServers.github.command).toBe("npx");
    expect(mcpServers).not.toHaveProperty("notion");
    expect(snapshot.github).not.toHaveProperty("alwaysLoad");
    expect(lastQueryOptions?.settingSources).toEqual([]);
    expect(lastQueryOptions?.strictMcpConfig).toBe(true);
  });

  it("keeps the in-process stageflow SDK server when two passed servers are merged", async () => {
    queryImpl = emptyStream;
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: {
        github: { command: "npx", args: ["-y", "pkg"] },
        slack: { command: "npx", args: ["-y", "slack"] },
      },
    });
    const mcpServers = lastQueryOptions?.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(mcpServers)).toEqual(["stageflow", "github", "slack"]);
    expect(mcpServers.stageflow.type).toBe("sdk");
    expect(mcpServers.github.alwaysLoad).toBe(true);
    expect(mcpServers.slack.alwaysLoad).toBe(true);
  });

  it("merges an HTTP snapshot beside stageflow with alwaysLoad at query time", async () => {
    queryImpl = emptyStream;
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const snapshot = { remote: { type: "http", url: "https://example.invalid/mcp" } };
    await adapter.runStage({ ...baseInput(), resolvedMcpServers: snapshot });
    const mcpServers = lastQueryOptions?.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(mcpServers)).toEqual(["stageflow", "remote"]);
    expect(mcpServers.remote).toMatchObject({
      type: "http",
      url: "https://example.invalid/mcp",
      alwaysLoad: true,
    });
    expect(snapshot.remote).not.toHaveProperty("alwaysLoad");
  });

  it("emit_stage_envelope still succeeds when a github snapshot is passed", async () => {
    queryImpl = async function* (options) {
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler({ status: "success", summary: "done with github", artifacts: [] }, undefined);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: { github: { command: "npx", args: ["-y", "pkg"] } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("done with github");
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("done");
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing emit_stage_envelope");
  });

  it("write_stage_artifact tool is registered alongside emit_stage_envelope", async () => {
    queryImpl = async function* (options) {
      const artifactTool = findTool(options, "write_stage_artifact");
      expect(artifactTool).toBeDefined();
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    await adapter.runStage(baseInput());
  });

  it("surfaces a thrown query() error as ok:false with the error message", async () => {
    queryImpl = async function* () {
      throw new Error("subprocess spawn failed");
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("subprocess spawn failed");
  });

  it("surfaces a thrown query() error even when a snapshot is passed, not as connect_failed", async () => {
    queryImpl = async function* () {
      throw new Error("subprocess spawn failed");
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: { github: { command: "npx", args: ["-y", "pkg"] } },
    });
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
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
});

describe("ClaudeAgentAdapter — MCP connect-fail", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "sf-claude-adapter-mcp-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("AE3: failed init status for a passed server fails the stage as connect_failed and interrupts", async () => {
    let emitHandlerRan = false;
    queryImpl = async function* (options) {
      yield initMessage("session-connect-fail", [{ name: "github", status: "failed" }]);
      const emitTool = findTool(options, "emit_stage_envelope");
      emitHandlerRan = true;
      await emitTool.handler({ status: "success", summary: "should not win", artifacts: [] }, undefined);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: { github: { command: "npx", args: ["-y", "pkg"] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/connect_failed|failed to connect/i);
      expect(result.reason).toMatch(/github/);
    }
    expect(lastInterruptSpy).toHaveBeenCalled();
    expect(emitHandlerRan).toBe(false);
  });

  it("treats needs-auth for a passed HTTP server as connect_failed", async () => {
    queryImpl = async function* () {
      yield initMessage("session-needs-auth", [{ name: "remote", status: "needs-auth" }]);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: { remote: { type: "http", url: "https://example.invalid/mcp" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/connect_failed|failed to connect/i);
      expect(result.reason).toMatch(/remote/);
    }
    expect(lastInterruptSpy).toHaveBeenCalled();
  });

  it("treats pending init status for a passed server as connect_failed", async () => {
    queryImpl = async function* () {
      yield initMessage("session-pending", [{ name: "github", status: "pending" }]);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: { github: { command: "npx", args: ["-y", "pkg"] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/connect_failed|failed to connect/i);
      expect(result.reason).toMatch(/github/);
    }
    expect(lastInterruptSpy).toHaveBeenCalled();
  });

  it("continues the turn when a passed server is connected and emit still succeeds", async () => {
    queryImpl = async function* (options) {
      yield initMessage("session-connected", [{ name: "github", status: "connected" }]);
      const emitTool = findTool(options, "emit_stage_envelope");
      await emitTool.handler({ status: "success", summary: "done with github", artifacts: [] }, undefined);
      yield userToolResultMessage("c1", "ok");
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage({
      ...baseInput(),
      resolvedMcpServers: { github: { command: "npx", args: ["-y", "pkg"] } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("done with github");
  });

  it("empty snapshot and init mcp_servers: [] does not connect_fail; missing emit still applies", async () => {
    queryImpl = async function* () {
      yield initMessage("session-empty");
      yield { type: "result", subtype: "success", is_error: false, result: "done talking" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing emit_stage_envelope");
      expect(result.reason).not.toMatch(/connect_failed/i);
    }
  });

  it("empty resolvedMcpServers plus default init mcp_servers: [] does not connect_fail", async () => {
    queryImpl = async function* () {
      yield initMessage("session-empty-snapshot");
      yield { type: "result", subtype: "success", is_error: false, result: "done talking" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage({ ...baseInput(), resolvedMcpServers: {} });
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: undefined }),
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

  it("does not register ask_operator when gate_kinds is an explicit empty array", async () => {
    queryImpl = async function* (options) {
      expect(() => findTool(options, "ask_operator")).toThrow();
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    await adapter.runStage(baseInput({ gate_kinds: [] }));
  });

  it("registers ask_operator when gate_kinds is undefined", async () => {
    queryImpl = async function* (options) {
      expect(() => findTool(options, "ask_operator")).not.toThrow();
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    await adapter.runStage(baseInput({ gate_kinds: undefined }));
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: undefined }),
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

  it("close({park:true}) after waiting does not throw and does not try to kill anything", async () => {
    queryImpl = async function* (options) {
      yield initMessage("session-xyz");
      const askTool = findTool(options, "ask_operator");
      const result = await askTool.handler({ kind: "confirm", message: "Proceed?" }, undefined);
      yield userToolResultMessage("c1", result.content);
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: undefined }),
      roots: buildStageRoots(workspaceDir, "review"),
    };
    const handle = adapter.openStage(input);
    await handle.next();
    await expect(handle.close({ park: true })).resolves.toBeUndefined();
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: undefined }),
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: undefined }),
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
      ...baseInput({ gate_kinds: undefined }),
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
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const input: StageRunInput = {
      ...baseInput({ gate_kinds: undefined }),
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

      const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
      const adapter = new ClaudeAgentAdapter();
      const input: StageRunInput = {
        ...baseInput({ gate_kinds: undefined }),
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
      const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
      const adapter = new ClaudeAgentAdapter();
      const input: StageRunInput = {
        ...baseInput({ gate_kinds: undefined }),
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

    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    const adapter = new ClaudeAgentAdapter();
    const result = await adapter.runStage(baseInput());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("ok");
  });
});
